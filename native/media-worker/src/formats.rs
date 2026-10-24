use crate::protocol::{Failure, RemoteReader, Result};
use lofty::file::FileType;
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Technical {
    pub container: &'static str,
    pub codec: &'static str,
    pub lossless: Option<bool>,
    pub sample_rate_hz: u32,
    pub channels: u8,
    pub bits_per_sample: Option<u8>,
    pub duration_seconds: Option<f64>,
    pub evidence: &'static str,
}
pub struct Container {
    pub name: &'static str,
    pub file_type: Option<FileType>,
    pub facts: Option<Technical>,
    pub id3_ranges: Vec<(u64, usize)>,
    pub wave_tag_lists: Vec<u64>,
    pub wave_tail_padding: bool,
    pub wave_info_ranges: Vec<(u64, usize)>,
}
fn simple(name: &'static str, kind: FileType) -> Container { Container { name, file_type: Some(kind), facts: None, id3_ranges: vec![], wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] } }
fn facts(container: &'static str, codec: &'static str, lossless: Option<bool>, rate: u32, channels: u8, bits: Option<u8>, duration: Option<f64>) -> Technical {
    Technical { container, codec, lossless, sample_rate_hz: rate, channels, bits_per_sample: bits, duration_seconds: duration, evidence: "bounded-parser-reported" }
}
pub fn le16(b: &[u8], at: usize) -> u16 { u16::from_le_bytes(b[at..at + 2].try_into().unwrap()) }
pub fn le32(b: &[u8], at: usize) -> u32 { u32::from_le_bytes(b[at..at + 4].try_into().unwrap()) }
pub fn be16(b: &[u8], at: usize) -> u16 { u16::from_be_bytes(b[at..at + 2].try_into().unwrap()) }
pub fn be32(b: &[u8], at: usize) -> u32 { u32::from_be_bytes(b[at..at + 4].try_into().unwrap()) }
pub fn le64(b: &[u8], at: usize) -> u64 { u64::from_le_bytes(b[at..at + 8].try_into().unwrap()) }
pub fn be64(b: &[u8], at: usize) -> u64 { u64::from_be_bytes(b[at..at + 8].try_into().unwrap()) }
pub fn end(at: u64, count: u64, limit: u64) -> Result<u64> { at.checked_add(count).filter(|v| *v <= limit).ok_or(Failure("PARSE_FAILED")) }
pub fn syncsafe(b: &[u8]) -> Result<usize> {
    if b.len() != 4 || b.iter().any(|n| *n > 127) { return Err(Failure("PARSE_FAILED")); }
    Ok(b.iter().fold(0, |a, n| a * 128 + usize::from(*n)))
}
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes { crc ^= u32::from(*byte); for _ in 0..8 { crc = (crc >> 1) ^ if crc & 1 != 0 { 0xedb8_8320 } else { 0 }; } }
    crc ^ 0xffff_ffff
}

pub fn inspect(reader: &mut RemoteReader<'_>, dsd_enabled: bool, cue_enabled: bool, artwork: bool) -> Result<Container> {
    let first = reader.range(0, reader.size.min(64) as usize)?;
    let mut at = 0u64;
    if first.starts_with(b"ID3") {
        if first.len() < 10 { return Err(Failure("PARSE_FAILED")); }
        let length = syncsafe(&first[6..10])?;
        if length > reader.budget.single_allocation_bytes { return Err(Failure("BUDGET_EXCEEDED")); }
        at = end(10, length as u64 + if first[3] == 4 && first[5] & 16 != 0 { 10 } else { 0 }, reader.size)?;
    }
    let header = if at == 0 { first } else { reader.range(at, (reader.size - at).min(64) as usize)? };
    if header.starts_with(b"DSD ") || header.starts_with(b"FRM8") {
        if !artwork && !dsd_enabled { return Err(Failure("UNSUPPORTED")); }
        return dsd(reader);
    }
    if header.starts_with(b"fLaC") {
        let mut container = simple("FLAC", FileType::Flac);
        let stream = reader.range(at + 4, 38)?;
        if stream[0] & 127 != 0 || stream[1..4] != [0, 0, 34] { return Err(Failure("PARSE_FAILED")); }
        let packed = be64(&stream, 14); let rate = (packed >> 44) as u32; let channels = ((packed >> 41) & 7) as u8 + 1;
        let bits = ((packed >> 36) & 31) as u8 + 1; let samples = packed & 0x0f_ffff_ffff;
        if rate == 0 || be16(&stream, 4) == 0 || be16(&stream, 6) < be16(&stream, 4) { return Err(Failure("PARSE_FAILED")); }
        let mut pos = at + 4; let mut last = false;
        for count in 0..4096 {
            let h = reader.range(pos, 4)?; let n = u64::from(h[1]) * 65536 + u64::from(h[2]) * 256 + u64::from(h[3]);
            if count >= 2048 || h[0] & 127 > 6 || count > 0 && h[0] & 127 == 0 { return Err(Failure("PARSE_FAILED")); }
            if n > reader.budget.single_allocation_bytes as u64 { return Err(Failure("BUDGET_EXCEEDED")); }
            pos = end(pos + 4, n, reader.size)?;
            if h[0] & 128 != 0 { last = true; break; }
        }
        if !last { return Err(Failure("PARSE_FAILED")); }
        check_flac_frame(reader, pos, &stream, rate, channels, bits)?;
        container.facts = Some(facts("FLAC", "FLAC", Some(true), rate, channels, Some(bits), if samples > 0 { Some(samples as f64 / f64::from(rate)) } else { None }));
        return Ok(container);
    }
    if header.starts_with(b"RIFF") { return wave(reader, at); }
    if header.starts_with(b"FORM") { return aiff(reader, at); }
    if header.len() >= 12 && &header[4..8] == b"ftyp" { return mp4(reader); }
    if header.starts_with(b"OggS") {
        if !artwork && !cue_enabled { return Err(Failure("UNSUPPORTED")); }
        return ogg(reader);
    }
    if header.starts_with(b"wvpk") {
        if !artwork && !cue_enabled { return Err(Failure("UNSUPPORTED")); }
        check_wavpack(reader)?;
        let mut c = simple("WAVPACK", FileType::WavPack); let flags = le32(&header, 24);
        let rates = [6000, 8000, 9600, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 192000, 0];
        let rate = rates[((flags >> 23) & 15) as usize];
        let stored = ((flags & 3) + 1) * 8; let shift = (flags >> 13) & 31;
        if shift >= stored { return Err(Failure("PARSE_FAILED")); }
        // 多声道由 channel-info 元数据报告，不能把首个 stereo block 当成整件文件。
        c.facts = Some(facts("WAVPACK", if flags & 128 != 0 { "IEEE_FLOAT" } else { "PCM" }, Some(flags & 8 == 0), rate, 0, None, None));
        return Ok(c);
    }
    if header.starts_with(b"MAC ") {
        if !artwork && !cue_enabled { return Err(Failure("UNSUPPORTED")); }
        return ape(reader);
    }
    if header.starts_with(b"MPCK") || header.starts_with(b"MP+") {
        if !artwork && !cue_enabled { return Err(Failure("UNSUPPORTED")); }
        return musepack(reader);
    }
    if header.starts_with(b"TTA1") || header.starts_with(b"tBaK") {
        if !artwork && !cue_enabled { return Err(Failure("UNSUPPORTED")); }
        return if header.starts_with(b"TTA1") { tta(reader) } else { tak(reader) };
    }
    if header.len() >= 4 && header[0] == 255 && header[1] & 224 == 224 {
        let version = (header[1] >> 3) & 3; let layer = (header[1] >> 1) & 3; let rate = (header[2] >> 2) & 3; let bitrate = header[2] >> 4;
        if version == 1 || layer != 1 || rate == 3 || bitrate == 0 || bitrate == 15 { return Err(Failure("UNSUPPORTED")); }
        let rates = [44100,48000,32000]; let rate = rates[rate as usize] / if version == 3 { 1 } else if version == 2 { 2 } else { 4 };
        let high = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]; let low = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
        let bitrate = if version == 3 { high[bitrate as usize] } else { low[bitrate as usize] };
        let size = (if version == 3 { 144 } else { 72 }) * bitrate * 1000 / rate + u32::from((header[2] >> 1) & 1);
        end(at, u64::from(size), reader.size)?;
        let mut c = simple("MPEG", FileType::Mpeg);
        c.facts = Some(facts("MPEG", if version == 3 { "MPEG 1 Layer 3" } else if version == 2 { "MPEG 2 Layer 3" } else { "MPEG 2.5 Layer 3" }, Some(false), rate,
            if header[3] >> 6 == 3 { 1 } else { 2 }, None, None)); return Ok(c);
    }
    Err(Failure("UNSUPPORTED"))
}

pub(crate) fn wave(reader: &mut RemoteReader<'_>, at: u64) -> Result<Container> {
    let h = reader.range(at, 12)?;
    if &h[8..12] != b"WAVE" { return Err(Failure("UNSUPPORTED")); }
    let limit = end(at + 8, u64::from(le32(&h, 4)), reader.size)?;
    let mut pos = at + 12; let mut technical = None; let mut audio_bytes = 0u64; let mut data_sizes = vec![]; let mut data = false; let mut align = 0u64;
    let mut fact_samples = None;
    let mut wave_tag_lists = vec![]; let mut wave_tail_padding = false; let mut wave_info_ranges = vec![];
    for _ in 0..4096 {
        if pos == limit { break; }
        let h = reader.range(pos, 8)?; let n = u64::from(le32(&h, 4)); let start = pos + 8; let next = end(start, n, limit)?;
        if &h[..4] == b"fmt " {
            if technical.is_some() || n < 16 { return Err(Failure("PARSE_FAILED")); }
            let f = reader.range(start, n.min(40) as usize)?;
            let tag = le16(&f, 0); let channels = le16(&f, 2); let rate = le32(&f, 4); let bits = le16(&f, 14); align = u64::from(le16(&f, 12));
            if channels == 0 || channels > 64 || rate == 0 || rate > 1_000_000_000 || bits > 64 { return Err(Failure("PARSE_FAILED")); }
            if n != 16 && (n < 18 || u64::from(le16(&f, 16)) + 18 > n) { return Err(Failure("PARSE_FAILED")); }
            let (codec, lossless) = if tag == 1 { ("PCM", Some(true)) } else if tag == 3 { ("IEEE_FLOAT", Some(true)) }
                else if tag == 0xfffe {
                    if n < 40 || le16(&f, 16) < 22 { return Err(Failure("PARSE_FAILED")); }
                    if f[24..40] == [1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113] { ("PCM", Some(true)) }
                    else if f[24..40] == [3,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113] { ("IEEE_FLOAT", Some(true)) }
                    else { ("WAVE_EXTENSIBLE_UNKNOWN", None) }
                } else { ("WAVE_OTHER", if [2,6,7,17,49,80,85,255,0x1600,0x1602].contains(&tag) { Some(false) } else { None }) };
            if lossless == Some(true) {
                let valid = if tag == 0xfffe { le16(&f, 18) } else { bits };
                if bits < 8 || bits % 8 != 0 || valid == 0 || valid > bits || align != u64::from(channels) * u64::from(bits) / 8
                    || u64::from(le32(&f, 8)) != u64::from(rate) * align
                    || codec == "IEEE_FLOAT" && (bits != 32 && bits != 64 || valid != bits) { return Err(Failure("PARSE_FAILED")); }
                if tag == 0xfffe && le32(&f, 20) != 0 && le32(&f, 20).count_ones() != u32::from(channels) { return Err(Failure("PARSE_FAILED")); }
            }
            technical = Some(facts("WAVE", codec, lossless, rate, channels as u8, if bits > 0 { Some(bits as u8) } else { None }, None));
        } else if &h[..4] == b"fact" {
            if n < 4 { return Err(Failure("PARSE_FAILED")); }
            if fact_samples.unwrap_or(0) == 0 { fact_samples = Some(le32(&reader.range(start, 4)?, 0)); }
        } else if &h[..4] == b"data" { if n == 0 { return Err(Failure("PARSE_FAILED")); } data = true; audio_bytes += n; data_sizes.push(n); }
        else if &h[..4] == b"LIST" && n == 0 { wave_tag_lists.push(pos); }
        else if &h[..4] == b"LIST" && n >= 4 && reader.range(start, 4)? == b"INFO" {
            if n > reader.budget.single_allocation_bytes as u64 { return Err(Failure("BUDGET_EXCEEDED")); }
            wave_tag_lists.push(pos); wave_info_ranges.push((start, n as usize));
        }
        if n % 2 == 1 && next == limit && limit == reader.size { wave_tail_padding = true; pos = limit; break; }
        pos = end(next, n % 2, limit)?;
    }
    if pos != limit || !data { return Err(Failure("PARSE_FAILED")); }
    let mut technical = technical.ok_or(Failure("PARSE_FAILED"))?;
    if technical.lossless == Some(true) {
        if align == 0 || data_sizes.iter().any(|n| n % align != 0) { return Err(Failure("PARSE_FAILED")); }
        technical.duration_seconds = Some(audio_bytes as f64 / align as f64 / f64::from(technical.sample_rate_hz));
    } else if let Some(samples) = fact_samples.filter(|samples| *samples > 0) {
        // 未知编码只沿真实fact样本数给出时长，不从数据长度猜PCM或赋予无损资格。
        technical.duration_seconds = Some(f64::from(samples) / f64::from(technical.sample_rate_hz));
    }
    Ok(Container { name: "WAVE", file_type: Some(FileType::Wav), facts: Some(technical), id3_ranges: vec![], wave_tag_lists, wave_tail_padding, wave_info_ranges })
}

fn aiff(reader: &mut RemoteReader<'_>, at: u64) -> Result<Container> {
    let h = reader.range(at, 12)?;
    let compressed = &h[8..12] == b"AIFC";
    if &h[8..12] != b"AIFF" && !compressed { return Err(Failure("UNSUPPORTED")); }
    let limit = end(at + 8, u64::from(be32(&h, 4)), reader.size)?; let mut pos = at + 12; let mut technical = None; let mut audio = false;
    for _ in 0..4096 {
        if pos == limit { break; }
        let h = reader.range(pos, 8)?; let n = u64::from(be32(&h, 4)); let start = pos + 8; let next = end(start, n, limit)?;
        if &h[..4] == b"COMM" {
            if technical.is_some() || n < if compressed { 22 } else { 18 } { return Err(Failure("PARSE_FAILED")); }
            let b = reader.range(start, n.min(22) as usize)?;
            let channels = be16(&b, 0); let samples = be32(&b, 2); let bits = be16(&b, 6); let exponent = be16(&b, 8);
            let rate = (be64(&b, 10) as f64) * 2f64.powi(i32::from(exponent & 0x7fff) - 16383 - 63);
            if exponent & 0x8000 != 0 || !rate.is_finite() || rate.fract() != 0.0 || rate < 1.0 || rate > 1_000_000_000.0 || channels == 0 || channels > 64 || bits == 0 || bits > 64 { return Err(Failure("PARSE_FAILED")); }
            let (codec, lossless) = if !compressed || [&b"NONE"[..], &b"twos"[..], &b"sowt"[..]].contains(&&b[18..22]) { ("PCM", Some(true)) }
                else if [&b"fl32"[..], &b"fl64"[..], &b"FL32"[..], &b"FL64"[..]].contains(&&b[18..22]) { ("IEEE_FLOAT", Some(true)) }
                else { ("AIFF_OTHER", None) };
            technical = Some(facts("AIFF", codec, lossless, rate as u32, channels as u8, Some(bits as u8), Some(f64::from(samples) / rate)));
        } else if &h[..4] == b"SSND" { audio = n > 8; }
        pos = end(next, n % 2, limit)?;
    }
    if pos != limit || !audio { return Err(Failure("PARSE_FAILED")); }
    Ok(Container { name: "AIFF", file_type: Some(FileType::Aiff), facts: Some(technical.ok_or(Failure("PARSE_FAILED"))?), id3_ranges: vec![], wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] })
}

fn mp4(reader: &mut RemoteReader<'_>) -> Result<Container> {
    fn atoms(reader: &mut RemoteReader<'_>, start: u64, limit: u64, depth: usize, count: &mut usize, codec: &mut Option<&'static str>, moov: &mut bool, media: &mut bool) -> Result<()> {
        if depth > 16 { return Err(Failure("BUDGET_EXCEEDED")); }
        let mut at = start;
        while at < limit {
            *count += 1; if *count > 4096 || limit - at < 8 { return Err(Failure("BUDGET_EXCEEDED")); }
            let h = reader.range(at, 8)?; let mut n = u64::from(be32(&h, 0)); let mut header = 8;
            if n == 1 { n = be64(&reader.range(at + 8, 8)?, 0); header = 16; } else if n == 0 { n = limit - at; }
            if n < header { return Err(Failure("PARSE_FAILED")); }
            let next = end(at, n, limit)?; let kind = &h[4..8];
            if kind == b"moov" { *moov = true; }
            if kind == b"mdat" && n > header { *media = true; }
            if [b"moov", b"trak", b"mdia", b"minf", b"stbl"].iter().any(|id| &id[..] == kind) { atoms(reader, at + header, next, depth + 1, count, codec, moov, media)?; }
            else if kind == b"stsd" {
                let b = reader.range(at + header, 8)?; let entries = be32(&b, 4); let mut p = at + header + 8;
                if entries == 0 || entries > 32 { return Err(Failure("UNSUPPORTED")); }
                for _ in 0..entries {
                    let h = reader.range(p, 8)?; let length = u64::from(be32(&h, 0));
                    if length < 8 { return Err(Failure("PARSE_FAILED")); }
                    let end = end(p, length, next)?;
                    let found = if &h[4..8] == b"alac" { Some("ALAC") } else if &h[4..8] == b"mp4a" { Some("AAC") } else { None };
                    if found == Some("AAC") { check_aac_entry(reader, p, end)?; }
                    if let Some(found) = found { if codec.is_some() && *codec != Some(found) { return Err(Failure("UNSUPPORTED")); } *codec = Some(found); }
                    p = end;
                }
                if p != next { return Err(Failure("PARSE_FAILED")); }
            }
            at = next;
        }
        Ok(())
    }
    let mut codec = None; let mut moov = false; let mut media = false;
    let size = reader.size; let mut count = 0;
    atoms(reader, 0, size, 0, &mut count, &mut codec, &mut moov, &mut media)?;
    if !moov || !media || codec.is_none() { return Err(Failure("UNSUPPORTED")); }
    let mut container = simple("MP4", FileType::Mp4);
    // rate/channels 在 Lofty 实际 sample entry 解析后填充；此处不从 ftyp 猜编码。
    container.facts = Some(facts("MP4", codec.unwrap(), Some(codec == Some("ALAC")), 0, 0, None, None)); Ok(container)
}

fn check_aac_entry(reader: &mut RemoteReader<'_>, at: u64, limit: u64) -> Result<()> {
    let h = reader.range(at, 36)?; let version = be16(&h, 16);
    let start = at + match version { 0 => 36, 1 => 52, 2 => 72, _ => return Err(Failure("UNSUPPORTED")) };
    fn descriptors(bytes: &[u8], at: usize, limit: usize, depth: usize) -> Result<bool> {
        if depth > 8 { return Err(Failure("BUDGET_EXCEEDED")); }
        let mut at = at;
        while at < limit {
            let tag = *bytes.get(at).ok_or(Failure("PARSE_FAILED"))?; at += 1;
            let mut size = 0usize; let mut complete = false;
            for _ in 0..4 { let byte = *bytes.get(at).ok_or(Failure("PARSE_FAILED"))?; at += 1; size = size * 128 + usize::from(byte & 127); if byte & 128 == 0 { complete = true; break; } }
            if !complete || size > limit.saturating_sub(at) { return Err(Failure("PARSE_FAILED")); }
            let end = at + size;
            if tag == 4 {
                if size < 13 || bytes[at + 1] >> 2 != 5 { return Err(Failure("PARSE_FAILED")); }
                return if [0x40,0x66,0x67,0x68].contains(&bytes[at]) { Ok(true) } else { Err(Failure("UNSUPPORTED")) };
            }
            if tag == 3 {
                if size < 3 { return Err(Failure("PARSE_FAILED")); }
                let flags = bytes[at + 2]; let mut child = at + 3;
                if flags & 128 != 0 { child += 2; }
                if flags & 64 != 0 { let n = usize::from(*bytes.get(child).ok_or(Failure("PARSE_FAILED"))?); child += 1 + n; }
                if flags & 32 != 0 { child += 2; }
                if child > end { return Err(Failure("PARSE_FAILED")); }
                if descriptors(bytes, child, end, depth + 1)? { return Ok(true); }
            }
            at = end;
        }
        Ok(false)
    }
    fn children(reader: &mut RemoteReader<'_>, start: u64, limit: u64, depth: usize) -> Result<bool> {
        if depth > 4 { return Err(Failure("BUDGET_EXCEEDED")); }
        let mut at = start;
        for _ in 0..256 {
            if at == limit { return Ok(false); }
            if limit.saturating_sub(at) < 8 { return Err(Failure("PARSE_FAILED")); }
            let h = reader.range(at, 8)?; let n = u64::from(be32(&h, 0)); if n < 8 { return Err(Failure("PARSE_FAILED")); } let next = end(at, n, limit)?;
            if &h[4..8] == b"esds" {
                if n < 12 || n > 256 * 1024 { return Err(Failure("BUDGET_EXCEEDED")); }
                let body = reader.range(at + 12, (n - 12) as usize)?; return descriptors(&body, 0, body.len(), 0);
            }
            if &h[4..8] == b"wave" && children(reader, at + 8, next, depth + 1)? { return Ok(true); }
            at = next;
        }
        Err(Failure("BUDGET_EXCEEDED"))
    }
    if start > limit || !children(reader, start, limit, 0)? { return Err(Failure("UNSUPPORTED")); } Ok(())
}

fn ape(reader: &mut RemoteReader<'_>) -> Result<Container> {
    let h = reader.range(0, 52)?; let version = le16(&h, 4); let descriptor = u64::from(le32(&h, 8));
    if !(3980..=3990).contains(&version) || le32(&h, 12) != 24 || le32(&h, 28) != 0 { return Err(Failure("UNSUPPORTED")); }
    let seek_bytes = le32(&h, 16) as usize; let wave_bytes = u64::from(le32(&h, 20)); let frames_bytes = u64::from(le32(&h, 24));
    if descriptor < 52 || seek_bytes < 4 || seek_bytes % 4 != 0 || frames_bytes < 8 { return Err(Failure("PARSE_FAILED")); }
    let b = reader.range(descriptor, 24)?; let blocks = le32(&b, 4); let final_blocks = le32(&b, 8); let frames = le32(&b, 12);
    let bits = le16(&b, 16); let channels = le16(&b, 18); let rate = le32(&b, 20);
    if !(1000..=5000).contains(&le16(&b, 0)) || le16(&b, 0) % 1000 != 0 || blocks == 0 || frames == 0 || final_blocks == 0 || final_blocks > blocks
        || frames as usize > seek_bytes / 4 || ![8,16,24,32].contains(&bits) || channels == 0 || channels > 2 || rate == 0 { return Err(Failure("PARSE_FAILED")); }
    let seek_at = end(descriptor, 24, reader.size)?; let audio_at = end(end(seek_at, seek_bytes as u64, reader.size)?, wave_bytes, reader.size)?;
    let audio_end = end(audio_at, frames_bytes, reader.size)?; end(audio_end, u64::from(le32(&h, 32)), reader.size)?;
    let seek = reader.range(seek_at, seek_bytes)?; let mut previous = 0;
    for i in 0..frames as usize {
        let n = u64::from(le32(&seek, i * 4));
        if n < audio_at || n >= audio_end || i == 0 && n != audio_at || i > 0 && n <= previous { return Err(Failure("PARSE_FAILED")); } previous = n;
    }
    reader.range(audio_at, 8)?; reader.range(audio_end - 1, 1)?;
    let samples = u64::from(frames - 1) * u64::from(blocks) + u64::from(final_blocks);
    Ok(Container { name: "APE", file_type: Some(FileType::Ape), facts: Some(facts("APE", "APE", Some(true), rate, channels as u8, Some(bits as u8), Some(samples as f64 / f64::from(rate)))), id3_ranges: vec![], wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] })
}

fn tta(reader: &mut RemoteReader<'_>) -> Result<Container> {
    let b = reader.range(0, 22)?; let channels = le16(&b, 6); let bits = le16(&b, 8); let rate = le32(&b, 10); let samples = le32(&b, 14);
    if crc32(&b[..18]) != le32(&b, 18) || channels == 0 || channels > 16 || rate == 0 || rate > 1_000_000 || samples == 0 { return Err(Failure("PARSE_FAILED")); }
    if le16(&b, 4) != 1 || ![8,16,24].contains(&bits) { return Err(Failure("UNSUPPORTED")); }
    let frame_samples = u64::from(rate) * 256 / 245; if frame_samples == 0 { return Err(Failure("PARSE_FAILED")); }
    let frames = u64::from(samples).div_ceil(frame_samples); let seek_bytes = frames as usize * 4;
    let seek = reader.range(22, seek_bytes + 4)?;
    if crc32(&seek[..seek_bytes]) != le32(&seek, seek_bytes) { return Err(Failure("PARSE_FAILED")); }
    let audio_at = 26 + seek_bytes as u64; let mut audio_end = audio_at;
    for i in 0..frames as usize { let size = le32(&seek, i * 4); if size < 5 { return Err(Failure("PARSE_FAILED")); } audio_end = end(audio_end, u64::from(size), reader.size)?; }
    reader.range(audio_at, 1)?; reader.range(audio_end - 4, 4)?;
    Ok(Container { name: "TTA", file_type: None, facts: Some(facts("TTA", "TTA", Some(true), rate, channels as u8, Some(bits as u8), Some(f64::from(samples) / f64::from(rate)))), id3_ranges: vec![], wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] })
}

fn qualify_dsd(rate: u32, channels: u32) -> Result<()> {
    if ![2_822_400,3_072_000,5_644_800,6_144_000,11_289_600,12_288_000,22_579_200,24_576_000].contains(&rate) || channels == 0 || channels > 6 {
        return Err(Failure("UNSUPPORTED"));
    }
    Ok(())
}
fn dsd(reader: &mut RemoteReader<'_>) -> Result<Container> {
    let first = reader.range(0, 16)?;
    if first.starts_with(b"DSD ") {
        let h = reader.range(0, 92)?;
        if le64(&h, 4) != 28 || le64(&h, 12) != reader.size || &h[28..32] != b"fmt " || le64(&h, 32) != 52 { return Err(Failure("PARSE_FAILED")); }
        if le32(&h, 40) != 1 || le32(&h, 44) != 0 { return Err(Failure("UNSUPPORTED")); }
        let kind = le32(&h, 48); let channels = le32(&h, 52); let rate = le32(&h, 56); qualify_dsd(rate, channels)?;
        let layout = [0,1,2,3,4,4,5,6].get(kind as usize).copied().ok_or(Failure("UNSUPPORTED"))?;
        if layout == 0 || layout != channels { return Err(Failure("PARSE_FAILED")); }
        let packing = le32(&h, 60); let samples = le64(&h, 64); let block = le32(&h, 72);
        if ![1,8].contains(&packing) || samples < 8 || samples > 9_007_199_254_740_991 || samples % 8 != 0 { return Err(Failure("UNSUPPORTED")); }
        if block != 4096 || le32(&h, 76) != 0 || &h[80..84] != b"data" { return Err(Failure("PARSE_FAILED")); }
        let data_bytes = le64(&h, 84).checked_sub(12).ok_or(Failure("PARSE_FAILED"))?;
        let expected = (samples / 8).div_ceil(u64::from(block)).checked_mul(u64::from(block)).and_then(|n| n.checked_mul(u64::from(channels))).ok_or(Failure("PARSE_FAILED"))?;
        if data_bytes != expected { return Err(Failure("PARSE_FAILED")); }
        let data_end = end(92, data_bytes, reader.size)?; let metadata = le64(&h, 20); let mut ranges = vec![];
        if metadata == 0 { if data_end != reader.size { return Err(Failure("PARSE_FAILED")); } }
        else {
            if metadata != data_end { return Err(Failure("PARSE_FAILED")); }
            let tag = reader.range(metadata, 10)?;
            if !tag.starts_with(b"ID3") || ![2,3,4].contains(&tag[3]) || tag[4] == 255 { return Err(Failure("PARSE_FAILED")); }
            let bytes = 10 + syncsafe(&tag[6..10])? + if tag[3] == 4 && tag[5] & 16 != 0 { 10 } else { 0 };
            if end(metadata, bytes as u64, reader.size)? != reader.size { return Err(Failure("PARSE_FAILED")); }
            ranges.push((metadata, bytes));
        }
        return Ok(Container { name: "DSF", file_type: None, facts: Some(facts("DSF", "DSD", Some(true), rate, channels as u8, Some(1), Some(samples as f64 / f64::from(rate)))), id3_ranges: ranges, wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] });
    }
    if &first[..4] != b"FRM8" || &first[12..16] != b"DSD " { return Err(Failure("UNSUPPORTED")); }
    if be64(&first, 4) != reader.size - 12 { return Err(Failure("PARSE_FAILED")); }
    fn chunk(reader: &mut RemoteReader<'_>, at: u64, limit: u64, count: &mut usize) -> Result<([u8; 4], u64, u64, u64)> {
        *count += 1; if *count > 2048 || limit.saturating_sub(at) < 12 { return Err(Failure("BUDGET_EXCEEDED")); }
        let h = reader.range(at, 12)?; let n = be64(&h, 4); let start = at + 12; let next = end(end(start, n, limit)?, n % 2, limit)?;
        Ok((h[..4].try_into().unwrap(), n, start, next))
    }
    let mut at = 16; let mut count = 0; let mut version = false; let mut properties = false;
    let mut rate = None; let mut channels = None; let mut compression = false; let mut data = None; let mut ranges = vec![];
    while at < reader.size {
        let size = reader.size; let (id, n, start, next) = chunk(reader, at, size, &mut count)?;
        if !version && (at != 16 || &id != b"FVER") { return Err(Failure("PARSE_FAILED")); }
        match &id {
            b"FVER" => {
                if version || n != 4 { return Err(Failure("PARSE_FAILED")); }
                let v = reader.range(start, 4)?; if v[0] != 1 || v[2] != 0 || v[3] != 0 { return Err(Failure("UNSUPPORTED")); } version = true;
            }
            b"PROP" => {
                if properties || data.is_some() || n < 4 || reader.range(start, 4)? != b"SND " { return Err(Failure("PARSE_FAILED")); }
                properties = true; let mut p = start + 4;
                while p < start + n {
                    let (id, size, payload, next) = chunk(reader, p, start + n, &mut count)?;
                    match &id {
                        b"FS  " => { if rate.is_some() || size != 4 { return Err(Failure("PARSE_FAILED")); } rate = Some(be32(&reader.range(payload, 4)?, 0)); }
                        b"CHNL" => {
                            if channels.is_some() || size < 2 { return Err(Failure("PARSE_FAILED")); }
                            let ch = be16(&reader.range(payload, 2)?, 0); if ch == 0 || ch > 6 { return Err(Failure("UNSUPPORTED")); }
                            if size != 2 + u64::from(ch) * 4 { return Err(Failure("PARSE_FAILED")); }
                            let ids = reader.range(payload + 2, usize::from(ch) * 4)?; let mut seen = vec![];
                            for id in ids.chunks_exact(4) { if id.iter().any(|b| !(32..=126).contains(b)) || seen.contains(&id) { return Err(Failure("PARSE_FAILED")); } seen.push(id); }
                            channels = Some(ch as u8);
                        }
                        b"CMPR" => {
                            if compression || !(5..=260).contains(&size) { return Err(Failure("PARSE_FAILED")); }
                            let v = reader.range(payload, size as usize)?; if &v[..4] != b"DSD " { return Err(Failure("UNSUPPORTED")); }
                            if size != 5 + u64::from(v[4]) { return Err(Failure("PARSE_FAILED")); } compression = true;
                        }
                        _ => {}
                    }
                    p = next;
                }
                qualify_dsd(rate.ok_or(Failure("PARSE_FAILED"))?, u32::from(channels.ok_or(Failure("PARSE_FAILED"))?))?;
                if !compression { return Err(Failure("PARSE_FAILED")); }
            }
            b"DSD " => { if !properties || data.is_some() || n == 0 { return Err(Failure("PARSE_FAILED")); } data = Some(n); }
            b"DST " | b"DSTI" => return Err(Failure("UNSUPPORTED")),
            b"ID3 " => { if n < 10 || n > reader.budget.single_allocation_bytes as u64 { return Err(Failure("BUDGET_EXCEEDED")); } ranges.push((start, n as usize)); }
            _ => {}
        }
        at = next;
    }
    let rate = rate.ok_or(Failure("PARSE_FAILED"))?; let channels = channels.ok_or(Failure("PARSE_FAILED"))?; let bytes = data.ok_or(Failure("PARSE_FAILED"))?;
    if at != reader.size || !version || !properties || bytes % u64::from(channels) != 0 { return Err(Failure("PARSE_FAILED")); }
    let samples = bytes.checked_mul(8).ok_or(Failure("PARSE_FAILED"))? / u64::from(channels);
    if samples > 9_007_199_254_740_991 { return Err(Failure("PARSE_FAILED")); }
    Ok(Container { name: "DFF", file_type: None, facts: Some(facts("DFF", "DSD", Some(true), rate, channels, Some(1), Some(samples as f64 / f64::from(rate)))), id3_ranges: ranges, wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] })
}

struct LittleBits<'a> { bytes: &'a [u8], position: usize }
impl LittleBits<'_> {
    fn get(&mut self, width: usize) -> Result<u64> {
        if width > 40 || self.position + width > self.bytes.len() * 8 { return Err(Failure("PARSE_FAILED")); }
        let mut n = 0; for bit in 0..width { n |= u64::from((self.bytes[self.position / 8] >> (self.position % 8)) & 1) << bit; self.position += 1; } Ok(n)
    }
    fn align(&mut self) { self.position = self.position.div_ceil(8) * 8; }
}
#[derive(Clone, PartialEq)]
struct TakInfo { codec: u64, profile: u64, samples: u64, frame_samples: u64, rate: u32, bits: u8, channels: u8 }
fn tak_info(bits: &mut LittleBits<'_>) -> Result<TakInfo> {
    let codec = bits.get(6)?; let profile = bits.get(4)?; let frame_type = bits.get(4)?; let samples = bits.get(35)?;
    let data_type = bits.get(3)?; let rate = (bits.get(18)? + 6000) as u32; let depth = (bits.get(5)? + 8) as u8; let channels = (bits.get(4)? + 1) as u8;
    if bits.get(1)? != 0 { bits.get(5)?; if bits.get(1)? != 0 { for _ in 0..channels { bits.get(6)?; } } }
    let quants = [3,4,6,8,4096,8192,16384,512,1024,2048];
    let quant = *quants.get(frame_type as usize).ok_or(Failure("PARSE_FAILED"))?;
    let frame_samples = if frame_type <= 3 { u64::from(rate) * quant / 32 } else { quant };
    if samples == 0 || frame_samples == 0 || frame_samples > if frame_type <= 3 { 16384 } else { u64::from(rate) * 8 / 32 } { return Err(Failure("PARSE_FAILED")); }
    if ![2,4].contains(&codec) || data_type != 0 || ![8,16,24].contains(&depth) || channels > 6 || codec == 2 && channels > 2 { return Err(Failure("UNSUPPORTED")); }
    Ok(TakInfo { codec, profile, samples, frame_samples, rate, bits: depth, channels })
}
fn tak_crc(bytes: &[u8]) -> u32 {
    let mut crc = 0xce04b7;
    for byte in bytes {
        let mut entry = ((crc & 255) ^ u32::from(*byte)) << 24;
        for _ in 0..8 { entry = (entry << 1) ^ if entry & 0x8000_0000 != 0 { 0x864c_fb00 } else { 0 }; }
        crc = entry.swap_bytes() ^ (crc >> 8);
    }
    crc & 0x00ff_ffff
}
fn be24(bytes: &[u8], at: usize) -> u32 { u32::from(bytes[at]) * 65536 + u32::from(bytes[at + 1]) * 256 + u32::from(bytes[at + 2]) }
fn tak(reader: &mut RemoteReader<'_>) -> Result<Container> {
    let mut at = 4u64; let mut info = None; let mut last = None; let mut audio_at = None;
    for _ in 0..4096 {
        let h = reader.range(at, 4)?; let kind = h[0] & 127; let n = usize::from(h[1]) + usize::from(h[2]) * 256 + usize::from(h[3]) * 65536;
        let next = end(at + 4, n as u64, reader.size)?;
        if kind > 7 { return Err(Failure("UNSUPPORTED")); }
        if n > reader.budget.single_allocation_bytes { return Err(Failure("BUDGET_EXCEEDED")); }
        if kind == 0 { if n != 0 { return Err(Failure("PARSE_FAILED")); } audio_at = Some(next); break; }
        if [1,4,6,7].contains(&kind) {
            if n <= 3 || kind == 6 && n != 19 || kind == 7 && n != 11 { return Err(Failure("PARSE_FAILED")); }
            let b = reader.range(at + 4, n)?; let body = &b[..n - 3]; if tak_crc(body) != be24(&b, n - 3) { return Err(Failure("PARSE_FAILED")); }
            if kind == 1 {
                if info.is_some() || !(10..=23).contains(&body.len()) { return Err(Failure("PARSE_FAILED")); }
                let mut bits = LittleBits { bytes: body, position: 0 }; info = Some(tak_info(&mut bits)?);
                if bits.position.div_ceil(8) != body.len() { return Err(Failure("PARSE_FAILED")); }
            } else if kind == 7 {
                if last.is_some() { return Err(Failure("PARSE_FAILED")); }
                let mut bits = LittleBits { bytes: body, position: 0 }; let offset = bits.get(40)?; let bytes = bits.get(24)?;
                if bytes < 12 { return Err(Failure("PARSE_FAILED")); } last = Some((offset, bytes));
            }
        }
        at = next;
    }
    let start = audio_at.ok_or(Failure("PARSE_FAILED"))?; let info = info.ok_or(Failure("PARSE_FAILED"))?;
    fn frame(reader: &mut RemoteReader<'_>, at: u64, limit: u64, number: u64, is_last: bool, info: &TakInfo) -> Result<()> {
        if limit.saturating_sub(at) < 12 { return Err(Failure("PARSE_FAILED")); }
        let data = reader.range(at, (limit - at).min(40) as usize)?; let mut bits = LittleBits { bytes: &data, position: 0 };
        if bits.get(16)? != 0xa0ff { return Err(Failure("PARSE_FAILED")); }
        let flags = bits.get(3)?;
        if bits.get(21)? != number || flags & 4 != 0 || (flags & 1 != 0) != is_last { return Err(Failure("PARSE_FAILED")); }
        let samples = if flags & 1 != 0 { let n = bits.get(14)? + 1; bits.get(2)?; n } else { info.frame_samples };
        if flags & 2 != 0 { if &tak_info(&mut bits)? != info { return Err(Failure("PARSE_FAILED")); } if bits.get(6)? != 0 { bits.get(25)?; } bits.align(); }
        else if number == 0 { return Err(Failure("PARSE_FAILED")); }
        let header_bytes = bits.position / 8;
        if bits.position % 8 != 0 || header_bytes + 3 > data.len() || header_bytes as u64 + 7 > limit - at
            || tak_crc(&data[..header_bytes]) != be24(&data, header_bytes) { return Err(Failure("PARSE_FAILED")); }
        let expected = if is_last { info.samples.checked_sub(number * info.frame_samples).ok_or(Failure("PARSE_FAILED"))? } else { info.frame_samples };
        if samples != expected || samples == 0 || samples > info.frame_samples { return Err(Failure("PARSE_FAILED")); }
        reader.range(at + header_bytes as u64 + 3, 1)?; Ok(())
    }
    let frames = info.samples.div_ceil(info.frame_samples); if frames == 0 || frames > 1 << 21 { return Err(Failure("PARSE_FAILED")); }
    let audio_end = if let Some((offset, bytes)) = last { end(start, offset + bytes, reader.size)? } else { reader.size };
    frame(reader, start, audio_end, 0, frames == 1, &info)?;
    if let Some((offset, _)) = last {
        if frames == 1 && offset != 0 || frames > 1 && offset == 0 { return Err(Failure("PARSE_FAILED")); }
        frame(reader, end(start, offset, audio_end)?, audio_end, frames - 1, true, &info)?;
    }
    Ok(Container { name: "TAK", file_type: None, facts: Some(facts("TAK", "TAK", Some(true), info.rate, info.channels, Some(info.bits), Some(info.samples as f64 / f64::from(info.rate)))), id3_ranges: vec![], wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] })
}

fn check_flac_frame(reader: &mut RemoteReader<'_>, at: u64, info: &[u8], rate: u32, channels: u8, depth: u8) -> Result<()> {
    let remaining = reader.size.saturating_sub(at);
    if remaining < 6 { return Err(Failure("PARSE_FAILED")); }
    let frame = reader.range(at, remaining.min(32) as usize)?;
    if frame[0] != 255 || frame[1] & 0xfe != 0xf8 || frame[3] & 1 != 0 { return Err(Failure("PARSE_FAILED")); }
    let block_code = frame[2] >> 4; let rate_code = frame[2] & 15; let channel_code = frame[3] >> 4; let bits_code = (frame[3] >> 1) & 7;
    if block_code == 0 || rate_code == 15 || channel_code > 10 || bits_code == 3 { return Err(Failure("PARSE_FAILED")); }
    let mut cursor = 4usize; let leading = frame[cursor]; cursor += 1;
    let mut number = u64::from(leading);
    if leading >= 128 {
        let width = leading.leading_ones() as usize;
        if !(2..=7).contains(&width) || cursor + width > frame.len() { return Err(Failure("PARSE_FAILED")); }
        number = u64::from(leading & ((1 << (7 - width)) - 1));
        for _ in 1..width { let byte = frame[cursor]; cursor += 1; if byte & 192 != 128 { return Err(Failure("PARSE_FAILED")); } number = number * 64 + u64::from(byte & 63); }
        let minimum = [0,0,128,2048,65536,2097152,67108864,2147483648];
        if number < minimum[width] { return Err(Failure("PARSE_FAILED")); }
    }
    if number != 0 { return Err(Failure("PARSE_FAILED")); }
    fn extra(frame: &[u8], cursor: &mut usize, width: usize) -> Result<u32> {
        if *cursor + width >= frame.len() { return Err(Failure("PARSE_FAILED")); }
        let n = if width == 1 { u32::from(frame[*cursor]) } else { u32::from(be16(frame, *cursor)) }; *cursor += width; Ok(n)
    }
    let samples = match block_code { 1 => 192, 2..=5 => 576 << (block_code - 2), 6 => extra(&frame, &mut cursor, 1)? + 1, 7 => extra(&frame, &mut cursor, 2)? + 1, _ => 256 << (block_code - 8) };
    let fixed_rates = [0,88200,176400,192000,8000,16000,22050,24000,32000,44100,48000,96000];
    let frame_rate = match rate_code { 0 => rate, 1..=11 => fixed_rates[rate_code as usize], 12 => extra(&frame, &mut cursor, 1)? * 1000, 13 => extra(&frame, &mut cursor, 2)?, _ => extra(&frame, &mut cursor, 2)? * 10 };
    let frame_channels = if channel_code < 8 { channel_code + 1 } else { 2 };
    let frame_depth = if bits_code == 0 { depth } else { [0,8,12,0,16,20,24,32][bits_code as usize] };
    if frame_rate != rate || frame_channels != channels || frame_depth != depth || samples == 0 || samples > u32::from(be16(info, 6)) || cursor >= frame.len() { return Err(Failure("PARSE_FAILED")); }
    let mut crc = 0u8;
    for byte in &frame[..cursor] { crc ^= *byte; for _ in 0..8 { crc = (crc << 1) ^ if crc & 128 != 0 { 7 } else { 0 }; } }
    if crc != frame[cursor] { return Err(Failure("PARSE_FAILED")); }
    let min_frame = u64::from(info[8]) * 65536 + u64::from(info[9]) * 256 + u64::from(info[10]);
    if remaining < min_frame.max(cursor as u64 + 1 + u64::from(channels) * 2 + 2) { return Err(Failure("PARSE_FAILED")); } Ok(())
}
fn check_wavpack(reader: &mut RemoteReader<'_>) -> Result<()> {
    let header = reader.range(0, 32)?; let limit = end(0, u64::from(le32(&header, 4)) + 8, reader.size)?;
    if !(0x402..=0x410).contains(&le16(&header, 8)) || limit <= 34 || le32(&header, 16) != 0 || le32(&header, 20) == 0 { return Err(Failure("PARSE_FAILED")); }
    if le32(&header, 24) & 0x8000_0000 != 0 { return Err(Failure("UNSUPPORTED")); }
    let mut at = 32; let mut audio = false;
    for _ in 0..4096 {
        if at == limit { return if audio { Ok(()) } else { Err(Failure("PARSE_FAILED")) }; }
        if limit.saturating_sub(at) < 2 { return Err(Failure("PARSE_FAILED")); }
        let h = reader.range(at, 2)?; let large = h[0] & 128 != 0; let odd = u64::from((h[0] >> 6) & 1);
        let words = if large { let n = reader.range(at + 1, 3)?; u64::from(n[0]) + u64::from(n[1]) * 256 + u64::from(n[2]) * 65536 } else { u64::from(h[1]) };
        let bytes = (words * 2).checked_sub(odd).ok_or(Failure("PARSE_FAILED"))?;
        let start = at + if large { 4 } else { 2 }; let next = end(start, words * 2, limit)?;
        if h[0] & 63 == 10 { if bytes == 0 { return Err(Failure("PARSE_FAILED")); } reader.range(start, 1)?; audio = true; }
        at = next;
    }
    Err(Failure("BUDGET_EXCEEDED"))
}
fn ogg_crc(bytes: &[u8]) -> u32 {
    let mut crc = 0u32;
    for (i, byte) in bytes.iter().enumerate() { crc ^= u32::from(if (22..26).contains(&i) { 0 } else { *byte }) << 24; for _ in 0..8 { crc = (crc << 1) ^ if crc & 0x8000_0000 != 0 { 0x04c1_1db7 } else { 0 }; } }
    crc
}
fn ogg(reader: &mut RemoteReader<'_>) -> Result<Container> {
    let mut at = 0u64; let mut serial = None; let mut packet_number = 0; let mut packet = Vec::new(); let mut technical: Option<Technical> = None;
    for page_number in 0..4096 {
        let h = reader.range(at, 27)?; let flags = h[5];
        if &h[..4] != b"OggS" || h[4] != 0 || flags > 7 || page_number == 0 && flags & 3 != 2
            || page_number != 0 && ((flags & 1 != 0) != !packet.is_empty() || flags & 2 != 0) { return Err(Failure("PARSE_FAILED")); }
        let page_serial = le32(&h, 14);
        if serial.is_some_and(|value| value != page_serial) { return Err(Failure("UNSUPPORTED")); }
        if le32(&h, 18) != page_number { return Err(Failure("PARSE_FAILED")); } serial = Some(page_serial);
        let laces = reader.range(at + 27, usize::from(h[26]))?; let payload: usize = laces.iter().map(|n| usize::from(*n)).sum();
        let page_bytes = 27 + laces.len() + payload; let next = end(at, page_bytes as u64, reader.size)?; let page = reader.range(at, page_bytes)?;
        if ogg_crc(&page) != le32(&h, 22) { return Err(Failure("PARSE_FAILED")); }
        let mut cursor = 27 + laces.len();
        for size in laces {
            let size = usize::from(size);
            if packet.len().saturating_add(size) > reader.budget.single_allocation_bytes { return Err(Failure("BUDGET_EXCEEDED")); }
            reader.reserve(size)?; packet.try_reserve(size).map_err(|_| Failure("BUDGET_EXCEEDED"))?;
            packet.extend_from_slice(&page[cursor..cursor + size]); cursor += size;
            if size == 255 { continue; }
            if packet_number == 0 {
                if packet.starts_with(b"OpusHead") {
                    if packet.len() < 19 || packet[8] > 15 || packet[9] == 0 || packet[9] > 64 { return Err(Failure("PARSE_FAILED")); }
                    let channels = packet[9]; let family = packet[18];
                    if family == 0 { if channels > 2 || packet.len() != 19 { return Err(Failure("PARSE_FAILED")); } }
                    else {
                        if packet.len() != 21 + usize::from(channels) || packet[19] == 0 || packet[20] > packet[19] || u16::from(packet[19]) + u16::from(packet[20]) > 255 { return Err(Failure("PARSE_FAILED")); }
                        for channel in &packet[21..] { if *channel != 255 && u16::from(*channel) >= u16::from(packet[19]) + u16::from(packet[20]) { return Err(Failure("PARSE_FAILED")); } }
                    }
                    technical = Some(facts("OGG", "Opus", Some(false), 48000, channels, None, None));
                } else if packet.starts_with(b"\x01vorbis") {
                    if packet.len() != 30 { return Err(Failure("PARSE_FAILED")); }
                    let channels = packet[11]; let rate = le32(&packet, 12); let low = packet[28] & 15; let high = packet[28] >> 4;
                    if le32(&packet, 7) != 0 || channels == 0 || channels > 64 || rate == 0 || rate > 1_000_000_000 || low < 6 || high > 13 || low > high || packet[29] & 1 == 0 { return Err(Failure("PARSE_FAILED")); }
                    technical = Some(facts("OGG", "Vorbis", Some(false), rate, channels, None, None));
                } else { return Err(Failure("UNSUPPORTED")); }
            } else {
                let info = technical.as_ref().ok_or(Failure("PARSE_FAILED"))?;
                if info.codec == "Opus" {
                    if packet_number == 1 { if !packet.starts_with(b"OpusTags") { return Err(Failure("PARSE_FAILED")); } }
                    else { if packet.is_empty() { return Err(Failure("PARSE_FAILED")); } return Ok(Container { name: "OGG", file_type: Some(FileType::Opus), facts: technical, id3_ranges: vec![], wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] }); }
                } else if packet_number < 3 {
                    if packet.len() < 7 || packet[0] != if packet_number == 1 { 3 } else { 5 } || &packet[1..7] != b"vorbis" { return Err(Failure("PARSE_FAILED")); }
                } else {
                    if packet.is_empty() || packet[0] & 1 != 0 { return Err(Failure("PARSE_FAILED")); }
                    return Ok(Container { name: "OGG", file_type: Some(FileType::Vorbis), facts: technical, id3_ranges: vec![], wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] });
                }
            }
            packet_number += 1; packet.clear();
        }
        if flags & 4 != 0 { return Err(Failure("PARSE_FAILED")); } at = next;
    }
    Err(Failure("BUDGET_EXCEEDED"))
}
fn musepack(reader: &mut RemoteReader<'_>) -> Result<Container> {
    let head = reader.range(0, 4)?; let rates = [44100,48000,37800,32000];
    let technical = if head.starts_with(b"MP+") {
        let h = reader.range(0, 28)?; let frames = le32(&h, 4); let rate = rates[(h[10] & 3) as usize]; let frame_bits = (le32(&h, 24) >> 4) & 0x000f_ffff;
        if ![7,0x17].contains(&h[3]) || frames == 0 || u64::from(frames) * 21 + 8 > reader.size.saturating_sub(24) * 8 || frame_bits == 0 || (u64::from(frame_bits) + 28).div_ceil(32) * 4 > reader.size.saturating_sub(24) { return Err(Failure("PARSE_FAILED")); }
        facts("MPC", "musepack7", Some(false), rate, 2, Some(16), Some(f64::from(frames) * 1152.0 / f64::from(rate)))
    } else {
        fn variable(bytes: &[u8], start: usize) -> Result<(u64, usize)> {
            let mut n = 0u64;
            for at in start..(start + 8).min(bytes.len()) { n = n.checked_mul(128).and_then(|n| n.checked_add(u64::from(bytes[at] & 127))).filter(|n| *n <= 9_007_199_254_740_991).ok_or(Failure("PARSE_FAILED"))?; if bytes[at] & 128 == 0 { return Ok((n, at + 1)); } }
            Err(Failure("PARSE_FAILED"))
        }
        let mut at = 4; let mut technical = None; let mut audio = false; let mut ended = false;
        for _ in 0..16_384 {
            if reader.size.saturating_sub(at) < 3 { return Err(Failure("PARSE_FAILED")); }
            let h = reader.range(at, (reader.size - at).min(10) as usize)?; let (size, offset) = variable(&h, 2)?;
            if !h[..2].iter().all(u8::is_ascii_uppercase) || size < offset as u64 { return Err(Failure("PARSE_FAILED")); }
            let next = end(at, size, reader.size)?; let start = at + offset as u64; let n = size - offset as u64;
            if &h[..2] == b"SH" {
                if technical.is_some() || !(9..=26).contains(&n) { return Err(Failure("PARSE_FAILED")); }
                let b = reader.range(start, n as usize)?; if be32(&b, 0) == 0 || b[4] != 8 { return Err(Failure("PARSE_FAILED")); }
                let (samples, p) = variable(&b, 5)?; let (silence, p) = variable(&b, p)?;
                if p + 2 != b.len() || samples == 0 || silence > samples { return Err(Failure("PARSE_FAILED")); }
                let rate = *rates.get((b[p] >> 5) as usize).ok_or(Failure("UNSUPPORTED"))?; let channels = (b[p + 1] >> 4) + 1;
                if channels > 2 { return Err(Failure("UNSUPPORTED")); }
                technical = Some(facts("MPC", "musepack8", Some(false), rate, channels, Some(16), Some(samples as f64 / f64::from(rate))));
            } else if &h[..2] == b"AP" { if technical.is_none() || n == 0 { return Err(Failure("PARSE_FAILED")); } reader.range(start, 1)?; audio = true; }
            else if &h[..2] == b"SE" { if n != 0 || !audio || technical.is_none() { return Err(Failure("PARSE_FAILED")); } ended = true; break; }
            at = next;
        }
        if !ended { return Err(Failure("PARSE_FAILED")); } technical.ok_or(Failure("PARSE_FAILED"))?
    };
    Ok(Container { name: "MPC", file_type: Some(FileType::Mpc), facts: Some(technical), id3_ranges: vec![], wave_tag_lists: vec![], wave_tail_padding: false, wave_info_ranges: vec![] })
}
