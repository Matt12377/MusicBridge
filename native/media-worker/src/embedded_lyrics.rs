use crate::formats;
use crate::protocol::{Failure, Job, RemoteReader, Result, log};
use serde_json::{Value, json};
use std::time::Instant;

const MAX_TEXT: usize = 64 * 1024;
const MAX_CANDIDATES: usize = 8;
const MAX_LINES: usize = 500;
const MAX_LINE_UNITS: usize = 2048;
const MAX_TIME_MS: u32 = 24 * 60 * 60 * 1000;

#[derive(Default)]
struct Lyrics { items: Vec<Value>, raw_bytes: usize, text_bytes: usize }
impl Lyrics {
    fn frame(&mut self, id: &[u8], version: u8, bytes: &[u8], reader: &mut RemoteReader<'_>) -> Result<()> {
        reader.check()?;
        if self.raw_bytes > reader.budget.total_text_bytes.min(MAX_TEXT) || self.items.len() >= MAX_CANDIDATES { return Err(Failure("BUDGET_EXCEEDED")); }
        if bytes.len() < 5 || bytes[0] > 3 || version == 2 && bytes[0] > 1 || !bytes[1..4].iter().all(u8::is_ascii_alphabetic) { return Err(Failure("PARSE_FAILED")); }
        let encoding = bytes[0]; let mut endian = None;
        let is_sync = id == b"SYLT" || id == b"SLT";
        let begin = if is_sync {
            if bytes.len() < 7 { return Err(Failure("PARSE_FAILED")); }
            if bytes[4] != 2 || bytes[5] != 1 { return Err(Failure("UNSUPPORTED")); } // WAV不能把MPEG帧时间猜成毫秒。
            6
        } else { 4 };
        let (description, mut at) = terminated(bytes, begin, encoding, &mut endian)?;
        self.text_bytes = self.text_bytes.saturating_add(description.len());
        if description.len() > reader.budget.text_field_bytes { return Err(Failure("BUDGET_EXCEEDED")); }
        if is_sync {
            let mut lines = Vec::new(); let mut previous = None;
            while at < bytes.len() {
                reader.check()?;
                if lines.len() >= MAX_LINES { return Err(Failure("BUDGET_EXCEEDED")); }
                let (text, next) = terminated(bytes, at, encoding, &mut endian)?; at = next;
                if at + 4 > bytes.len() { return Err(Failure("PARSE_FAILED")); }
                let start = formats::be32(bytes, at); at += 4;
                if start > MAX_TIME_MS || previous.is_some_and(|before| start < before) || (text.contains('\r') || text.contains('\n')) { return Err(Failure("PARSE_FAILED")); }
                if text.encode_utf16().count() > MAX_LINE_UNITS { return Err(Failure("BUDGET_EXCEEDED")); }
                self.text_bytes = self.text_bytes.saturating_add(text.len()); previous = Some(start);
                lines.push(json!({"startMs":start,"text":text}));
            }
            if self.text_bytes > reader.budget.total_text_bytes.min(MAX_TEXT) { return Err(Failure("BUDGET_EXCEEDED")); }
            if !lines.is_empty() { self.items.push(json!({"kind":"sylt","lines":lines})); }
        } else {
            let text = decoded(&bytes[at..], encoding, &mut endian)?.trim_end_matches('\0').to_owned();
            if text.contains('\0') { return Err(Failure("PARSE_FAILED")); }
            self.text_bytes = self.text_bytes.saturating_add(text.len());
            if self.text_bytes > reader.budget.total_text_bytes.min(MAX_TEXT) { return Err(Failure("BUDGET_EXCEEDED")); }
            if !text.is_empty() { self.items.push(json!({"kind":"uslt","text":text})); }
        }
        Ok(())
    }
}

// ID3显式编码，不猜本地代码页。UTF16正文可继承同frame描述的BOM，错误代理项整体拒绝。
fn decoded(bytes: &[u8], encoding: u8, endian: &mut Option<bool>) -> Result<String> {
    match encoding {
        0 => Ok(bytes.iter().map(|byte| char::from(*byte)).collect()),
        3 => std::str::from_utf8(bytes).map(str::to_owned).map_err(|_| Failure("PARSE_FAILED")),
        1 | 2 => {
            if bytes.is_empty() { return Ok(String::new()); }
            let (little, data) = if encoding == 2 { (false, bytes) }
                else if bytes.starts_with(&[255, 254]) { *endian = Some(true); (true, &bytes[2..]) }
                else if bytes.starts_with(&[254, 255]) { *endian = Some(false); (false, &bytes[2..]) }
                else { ((*endian).ok_or(Failure("PARSE_FAILED"))?, bytes) };
            if data.len() % 2 != 0 { return Err(Failure("PARSE_FAILED")); }
            let words: Vec<u16> = data.chunks_exact(2).map(|pair| if little { u16::from_le_bytes([pair[0], pair[1]]) } else { u16::from_be_bytes([pair[0], pair[1]]) }).collect();
            String::from_utf16(&words).map_err(|_| Failure("PARSE_FAILED"))
        }
        _ => Err(Failure("UNSUPPORTED")),
    }
}
fn terminated(bytes: &[u8], start: usize, encoding: u8, endian: &mut Option<bool>) -> Result<(String, usize)> {
    let width = if encoding == 1 || encoding == 2 { 2 } else { 1 };
    let mut at = start;
    while at + width <= bytes.len() {
        if bytes[at] == 0 && (width == 1 || bytes[at + 1] == 0) { return Ok((decoded(&bytes[start..at], encoding, endian)?, at + width)); }
        at += width;
    }
    Err(Failure("PARSE_FAILED"))
}
fn unsync(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len()); let mut at = 0;
    while at < bytes.len() { out.push(bytes[at]); if bytes[at] == 255 && bytes.get(at + 1) == Some(&0) { at += 1; } at += 1; }
    out
}
fn zeros(reader: &mut RemoteReader<'_>, mut at: u64, end: u64) -> Result<()> {
    while at < end {
        let count = (end - at).min(64 * 1024) as usize;
        if reader.range(at, count)?.iter().any(|byte| *byte != 0) { return Err(Failure("PARSE_FAILED")); }
        at += count as u64;
    }
    Ok(())
}
fn tag(reader: &mut RemoteReader<'_>, at: u64, count: u64, lyrics: &mut Lyrics) -> Result<()> {
    if count < 10 { return Err(Failure("PARSE_FAILED")); }
    let header = reader.range(at, 10)?;
    if !header.starts_with(b"ID3") || ![2, 3, 4].contains(&header[3]) || header[4] == 255 { return Err(Failure("PARSE_FAILED")); }
    let version = header[3]; let flags = header[5];
    if version == 2 && flags & 0x3f != 0 || version == 3 && flags & 0x1f != 0 || version == 4 && flags & 0x0f != 0 { return Err(Failure("PARSE_FAILED")); }
    // v2.2压缩和v2.2/3整tag unsync需读取整块，不能借歌词任务读取大APIC；明确不支持，不猜raw帧边界。
    if version < 4 && flags & 0x80 != 0 || version == 2 && flags & 0x40 != 0 { return Err(Failure("UNSUPPORTED")); }
    let length = formats::syncsafe(&header[6..10])? as u64;
    let end = formats::end(at + 10, length, at + count)?;
    let footer = if version == 4 && flags & 16 != 0 { 10 } else { 0 };
    let tag_end = formats::end(end, footer, at + count)?;
    if footer != 0 {
        let value = reader.range(end, 10)?;
        if &value[..3] != b"3DI" || value[3..] != header[3..] { return Err(Failure("PARSE_FAILED")); }
    }
    let mut position = at + 10;
    if flags & 64 != 0 {
        let bytes = reader.range(position, 4)?;
        let n = if version == 4 { formats::syncsafe(&bytes)? as u64 } else { u64::from(formats::be32(&bytes, 0)) + 4 };
        if n < if version == 4 { 6 } else { 10 } { return Err(Failure("PARSE_FAILED")); }
        position = formats::end(position, n, end)?;
    }
    for _ in 0..16_384 {
        reader.check()?;
        if position == end { zeros(reader, tag_end, at + count)?; return Ok(()); }
        let prefix = reader.range(position, 1)?;
        if prefix[0] == 0 { zeros(reader, position, end)?; zeros(reader, tag_end, at + count)?; return Ok(()); }
        let (id_bytes, header_bytes) = if version == 2 { (3, 6) } else { (4, 10) };
        formats::end(position, header_bytes, end)?;
        let h = reader.range(position, header_bytes as usize)?;
        let id = &h[..id_bytes];
        if !id.iter().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()) { return Err(Failure("PARSE_FAILED")); }
        let n = if version == 2 { usize::from(h[3]) * 65536 + usize::from(h[4]) * 256 + usize::from(h[5]) }
            else if version == 4 { formats::syncsafe(&h[4..8])? } else { formats::be32(&h, 4) as usize };
        let status = if version == 2 { 0 } else { h[8] }; let format = if version == 2 { 0 } else { h[9] };
        if version == 3 && (status & 0x1f != 0 || format & 0x1f != 0) || version == 4 && (status & 0x8f != 0 || format & 0xb0 != 0) { return Err(Failure("PARSE_FAILED")); }
        position += header_bytes; let next = formats::end(position, n as u64, end)?;
        if id == b"USLT" || id == b"ULT" || id == b"SYLT" || id == b"SLT" {
            if version == 3 && format != 0 || version == 4 && format & !3 != 0 { return Err(Failure("UNSUPPORTED")); }
            if n > reader.budget.total_text_bytes.min(MAX_TEXT) || lyrics.raw_bytes.saturating_add(n) > reader.budget.total_text_bytes.min(MAX_TEXT) { return Err(Failure("BUDGET_EXCEEDED")); }
            lyrics.raw_bytes += n;
            let raw = reader.range(position, n)?;
            let value = if version == 4 && (format & 2 != 0 || flags & 128 != 0) { unsync(&raw) } else { raw };
            let payload = if version == 4 && format & 1 != 0 {
                if value.len() < 4 || formats::syncsafe(&value[..4])? != value.len() - 4 { return Err(Failure("PARSE_FAILED")); }
                &value[4..]
            } else { &value };
            lyrics.frame(id, version, payload, reader)?;
        }
        position = next;
    }
    Err(Failure("BUDGET_EXCEEDED"))
}

/** 仅WAV内已有歌词：原容器/PCM守门后只随机读歌词帧，data/APIC正文从不请求。 */
pub fn process(job: &Job, reader: &mut RemoteReader<'_>, start: Instant) -> Result<Value> {
    log(job, start, "container-check", "正在检查歌词音频容器");
    if reader.size < 12 { return Err(Failure("PARSE_FAILED")); }
    let header = reader.range(0, 12)?;
    if !header.starts_with(b"RIFF") || &header[8..12] != b"WAVE" { return Err(Failure("UNSUPPORTED")); }
    if u64::from(formats::le32(&header, 4)) + 8 != reader.size { return Err(Failure("PARSE_FAILED")); }
    let container = formats::wave(reader, 0)?;
    let mut lyrics = Lyrics::default(); let mut at = 12;
    log(job, start, "parse", "正在读取内嵌同步歌词");
    for _ in 0..4096 {
        reader.check()?; if at == reader.size { return Ok(json!({"items":lyrics.items,"readEvidence":reader.evidence()})); }
        let h = reader.range(at, 8)?; let n = u64::from(formats::le32(&h, 4)); let end = formats::end(at + 8, n, reader.size)?;
        if &h[..4] == b"id3 " || &h[..4] == b"ID3 " { tag(reader, at + 8, n, &mut lyrics)?; }
        if n % 2 == 1 && end == reader.size && container.wave_tail_padding { at = end; }
        else { at = formats::end(end, n % 2, reader.size)?; }
    }
    if at == reader.size { Ok(json!({"items":lyrics.items,"readEvidence":reader.evidence()})) } else { Err(Failure("BUDGET_EXCEEDED")) }
}
