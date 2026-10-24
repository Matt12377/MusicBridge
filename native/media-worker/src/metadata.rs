use crate::formats::{self, Container, Technical};
use crate::protocol::{Failure, Job, PARSER_VERSION, RemoteReader, Result, log};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use lofty::{config::{GlobalOptions, ParseOptions, ParsingMode, apply_global_options}, file::{AudioFile, FileType, TaggedFileExt}, probe::Probe, tag::{Accessor, ItemKey, ItemValue, Tag}};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom};
use std::time::Instant;

#[path = "wave_tag_view.rs"]
mod wave_tag_view;

const CUE_PARSER_VERSION: &str = "musicbridge-cue-header/mbrs003-v1";
struct EncodedPicture { bytes: Vec<u8>, mime: &'static str }
#[derive(Default)]
struct Tags { fields: Map<String, Value>, pictures: Vec<EncodedPicture>, picture_count: usize, text_bytes: usize, cover_bytes: usize, items: usize }
fn picture_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("image/png") }
    else if bytes.starts_with(&[255,216,255]) { Some("image/jpeg") } else { None }
}
impl Tags {
    fn text(&mut self, value: &str, reader: &mut RemoteReader<'_>) -> Result<()> {
        self.items += 1; self.text_bytes = self.text_bytes.saturating_add(value.len()); reader.check()?;
        if self.items > 16_384 || value.len() > reader.budget.text_field_bytes || self.text_bytes > reader.budget.total_text_bytes { return Err(Failure("BUDGET_EXCEEDED")); }
        Ok(())
    }
    fn field(&mut self, key: &str, value: String, reader: &mut RemoteReader<'_>) -> Result<()> {
        if value.len() > reader.budget.text_field_bytes { return Err(Failure("BUDGET_EXCEEDED")); }
        if !self.fields.contains_key(key) { self.fields.insert(key.to_owned(), Value::String(value)); } Ok(())
    }
    // 仅标签明确的重复值或NUL分隔值成为多人；AC/DC、Earth, Wind & Fire等原名不猜拆。
    fn artist_value(&mut self, key: &str, value: &str, reader: &mut RemoteReader<'_>) -> Result<()> {
        let list_key = if key == "albumArtist" { "albumArtists" } else { "artists" };
        for name in value.split('\0').map(str::trim).filter(|name| !name.is_empty()) {
            if name.len() > reader.budget.text_field_bytes { return Err(Failure("BUDGET_EXCEEDED")); }
            self.field(key, name.to_owned(), reader)?;
            let values = self.fields.entry(list_key.to_owned()).or_insert_with(|| Value::Array(Vec::new()));
            let values = values.as_array_mut().ok_or(Failure("PARSE_FAILED"))?;
            if !values.iter().any(|value| value.as_str() == Some(name)) {
                if values.len() >= 64 { return Err(Failure("BUDGET_EXCEEDED")); }
                values.push(Value::String(name.to_owned()));
            }
        }
        Ok(())
    }
    fn picture(&mut self, data: &[u8], reader: &mut RemoteReader<'_>, artwork: bool) -> Result<()> {
        // 数量预算按实际遇到的图片计算，未知编码即使省略证据也必须占用名额。
        self.picture_count = self.picture_count.saturating_add(1);
        self.cover_bytes = self.cover_bytes.saturating_add(data.len()); reader.check()?;
        let total_limit = if artwork { 8 * 1024 * 1024 } else { reader.budget.cover_bytes };
        if data.len() > reader.budget.cover_bytes || self.cover_bytes > total_limit || self.picture_count > if artwork { 3 } else { 8 } { return Err(Failure("BUDGET_EXCEEDED")); }
        if let Some(mime) = picture_mime(data) { reader.reserve(data.len())?; self.pictures.push(EncodedPicture { bytes: data.to_vec(), mime }); }
        Ok(())
    }
    fn wave_info(&mut self, bytes: &[u8], reader: &mut RemoteReader<'_>) -> Result<()> {
        let mut at = 4usize;
        while at < bytes.len() {
            if bytes.len() - at < 8 { return Err(Failure("PARSE_FAILED")); }
            if !bytes[at..at+4].iter().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()) { return Err(Failure("PARSE_FAILED")); }
            let n = formats::le32(bytes, at + 4) as usize;
            let start = at + 8;
            let end = start.checked_add(n).filter(|end| *end <= bytes.len()).ok_or(Failure("PARSE_FAILED"))?;
            self.items += 1; self.text_bytes = self.text_bytes.saturating_add(n); reader.check()?;
            if self.items > 16_384 || n > reader.budget.text_field_bytes || self.text_bytes > reader.budget.total_text_bytes { return Err(Failure("BUDGET_EXCEEDED")); }
            // RIFF INFO没有统一编码；只接受明确UTF-8，未知编码不猜测且仍占原预算。
            if let Ok(raw) = std::str::from_utf8(&bytes[start..end]) {
                let text = raw.trim_matches('\0');
                let key = match &bytes[at..at+4] { b"INAM" => Some("title"), b"IART" => Some("artist"), b"IPRD" => Some("album"), b"ICRD" => Some("year"), b"IPRT" | b"ITRK" => Some("track"), _ => None };
                if let Some(key) = key {
                    let value = if key == "year" {
                        let year: String = text.trim_start().chars().take(4).collect();
                        if year.len() == 4 && year.bytes().all(|byte| byte.is_ascii_digit()) { year.parse::<u32>().ok().map(|value| value.to_string()) } else { None }
                    } else if key == "track" { text.parse::<u32>().ok().map(|value| value.to_string()) }
                    else { Some(text.to_owned()) };
                    if let Some(value) = value { if key == "artist" { self.artist_value(key, &value, reader)?; } else { self.field(key, value, reader)?; } }
                }
            }
            at = end.checked_add(n % 2).filter(|next| *next <= bytes.len()).ok_or(Failure("PARSE_FAILED"))?;
        }
        Ok(())
    }
    fn lofty(&mut self, tags: &[Tag], reader: &mut RemoteReader<'_>, artwork: bool) -> Result<()> {
        for tag in tags {
            for item in tag.items() {
                self.text(item.description(), reader)?;
                match item.value() {
                    ItemValue::Text(value) | ItemValue::Locator(value) => self.text(value, reader)?,
                    ItemValue::Binary(value) => if value.len() > reader.budget.single_allocation_bytes { return Err(Failure("BUDGET_EXCEEDED")); },
                }
            }
            for (key, value) in [("title", tag.title()), ("artist", tag.artist()), ("album", tag.album())] {
                if let Some(value) = value { self.field(key, value.into_owned(), reader)?; }
            }
            for value in tag.get_strings(&ItemKey::TrackArtist) { self.artist_value("artist", value, reader)?; }
            for value in tag.get_strings(&ItemKey::AlbumArtist) { self.artist_value("albumArtist", value, reader)?; }
            for (key, value) in [("year", tag.year()), ("disc", tag.disk()), ("track", tag.track())] {
                if let Some(value) = value { self.field(key, value.to_string(), reader)?; }
            }
            for picture in tag.pictures() {
                if let Some(description) = picture.description() { self.text(description, reader)?; }
                self.picture(picture.data(), reader, artwork)?;
            }
        }
        Ok(())
    }
}

fn unsync(bytes: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(bytes.len()); let mut at = 0;
    while at < bytes.len() { output.push(bytes[at]); if bytes[at] == 255 && bytes.get(at + 1) == Some(&0) { at += 1; } at += 1; }
    output
}
fn id3_text(bytes: &[u8]) -> Result<String> {
    let encoding = *bytes.first().ok_or(Failure("PARSE_FAILED"))?; let content = &bytes[1..];
    let value = match encoding {
        0 => content.iter().map(|b| char::from(*b)).collect(),
        3 => std::str::from_utf8(content).map_err(|_| Failure("PARSE_FAILED"))?.to_owned(),
        1 | 2 => {
            let (little, data) = if encoding == 1 {
                if content.starts_with(&[255,254]) { (true, &content[2..]) }
                else if content.starts_with(&[254,255]) { (false, &content[2..]) }
                else if content.is_empty() { (false, content) }
                else { return Err(Failure("PARSE_FAILED")); }
            } else { (false, content) };
            if data.len() % 2 != 0 { return Err(Failure("PARSE_FAILED")); }
            let units: Vec<u16> = data.chunks_exact(2).map(|b| if little { u16::from_le_bytes([b[0],b[1]]) } else { u16::from_be_bytes([b[0],b[1]]) }).collect();
            String::from_utf16(&units).map_err(|_| Failure("PARSE_FAILED"))?
        }
        _ => return Err(Failure("UNSUPPORTED")),
    };
    Ok(value.trim_end_matches('\0').to_owned())
}
fn id3_picture(bytes: &[u8], old: bool) -> Result<&[u8]> {
    let encoding = *bytes.first().ok_or(Failure("PARSE_FAILED"))?;
    if encoding > 3 { return Err(Failure("UNSUPPORTED")); }
    let mut at = if old {
        if bytes.len() < 5 || ![&b"PNG"[..], &b"JPG"[..]].contains(&&bytes[1..4]) { return Err(Failure("UNSUPPORTED")); } 5
    } else {
        let end = bytes.iter().skip(1).position(|b| *b == 0).map(|n| n + 1).ok_or(Failure("PARSE_FAILED"))?;
        if end > 256 || ![&b"image/png"[..], &b"image/jpeg"[..]].contains(&&bytes[1..end]) { return Err(Failure("UNSUPPORTED")); }
        if bytes.len() <= end + 1 || bytes[end + 1] > 20 { return Err(Failure("PARSE_FAILED")); } end + 2
    };
    let step = if encoding == 1 || encoding == 2 { 2 } else { 1 }; let begin = at;
    while at + step <= bytes.len() && at - begin <= 4096 {
        if bytes[at] == 0 && (step == 1 || bytes[at + 1] == 0) { return Ok(&bytes[at + step..]); } at += step;
    }
    Err(Failure("BUDGET_EXCEEDED"))
}
fn read_id3(reader: &mut RemoteReader<'_>, at: u64, bytes: usize, tags: &mut Tags, artwork: bool, include_pictures: bool) -> Result<()> {
    let header = reader.range(at, 10)?;
    if !header.starts_with(b"ID3") || ![2,3,4].contains(&header[3]) || header[4] == 255 { return Err(Failure("UNSUPPORTED")); }
    let version = header[3]; let flags = header[5]; let n = formats::syncsafe(&header[6..10])?;
    let footer = if version == 4 && flags & 16 != 0 { 10 } else { 0 };
    if n + 10 + footer != bytes || version == 2 && flags & 0x7f != 0 || version == 3 && flags & 0x1f != 0 || version == 4 && flags & 0x0f != 0 { return Err(Failure("UNSUPPORTED")); }
    let raw = reader.range(at + 10, n)?; let decoded = if flags & 128 != 0 && version < 4 { unsync(&raw) } else { raw };
    let body = decoded.as_slice(); let mut position = 0usize;
    if flags & 64 != 0 {
        if body.len() < 4 || version == 2 { return Err(Failure("UNSUPPORTED")); }
        let size = if version == 4 { formats::syncsafe(&body[..4])? } else { formats::be32(body, 0) as usize + 4 };
        if size < if version == 4 { 6 } else { 10 } || size > body.len() { return Err(Failure("PARSE_FAILED")); } position = size;
    }
    for count in 0..16_384 {
        reader.check()?;
        if position == body.len() { return Ok(()); }
        if body[position] == 0 { return if body[position..].iter().all(|b| *b == 0) { Ok(()) } else { Err(Failure("PARSE_FAILED")) }; }
        let id_bytes = if version == 2 { 3 } else { 4 }; let header_bytes = if version == 2 { 6 } else { 10 };
        if position + header_bytes > body.len() { return Err(Failure("PARSE_FAILED")); }
        let id = &body[position..position + id_bytes]; if !id.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) { return Err(Failure("PARSE_FAILED")); }
        let n = if version == 2 { usize::from(body[position + 3]) * 65536 + usize::from(body[position + 4]) * 256 + usize::from(body[position + 5]) }
            else if version == 4 { formats::syncsafe(&body[position + 4..position + 8])? } else { formats::be32(body, position + 4) as usize };
        let flag = if version == 2 { 0 } else { body[position + 9] };
        if version == 3 && flag != 0 || version == 4 && flag & !3 != 0 { return Err(Failure("UNSUPPORTED")); }
        position += header_bytes; let next = position.checked_add(n).filter(|end| *end <= body.len()).ok_or(Failure("PARSE_FAILED"))?;
        let raw = &body[position..next]; let data = if version == 4 && (flag & 2 != 0 || flags & 128 != 0) { unsync(raw) } else { raw.to_vec() };
        let value = if version == 4 && flag & 1 != 0 { if data.len() < 4 { return Err(Failure("PARSE_FAILED")); } formats::syncsafe(&data[..4])?; &data[4..] } else { &data };
        if id[0] == b'T' {
            let text = id3_text(value)?; tags.text(&text, reader)?;
            let key = match id { b"TIT2" | b"TT2" => Some("title"), b"TPE1" | b"TP1" => Some("artist"), b"TPE2" | b"TP2" => Some("albumArtist"), b"TALB" | b"TAL" => Some("album"), b"TYER" | b"TDRC" | b"TYE" => Some("year"), b"TRCK" | b"TRK" => Some("track"), b"TPOS" | b"TPA" => Some("disc"), _ => None };
            if let Some(key) = key {
                if key == "artist" || key == "albumArtist" { tags.artist_value(key, &text, reader)?; }
                else { let text = if key == "track" || key == "disc" { text.split('/').next().unwrap_or("").to_owned() } else if key == "year" { text.chars().take(4).collect() } else { text.replace('\0', "/") }; tags.field(key, text, reader)?; }
            }
        } else if include_pictures && (id == b"APIC" || id == b"PIC") { tags.picture(id3_picture(value, id == b"PIC")?, reader, artwork)?; }
        position = next;
        if count == 16_383 { return Err(Failure("BUDGET_EXCEEDED")); }
    }
    Err(Failure("BUDGET_EXCEEDED"))
}

fn generic_technical(container: &Container, kind: FileType, rate: u32, channels: u8, bits: Option<u8>, duration: Option<f64>) -> Result<Technical> {
    if rate == 0 || rate > 1_000_000_000 || channels == 0 || channels > 64 { return Err(Failure("PARSE_FAILED")); }
    let mut result = if let Some(facts) = &container.facts { facts.clone() } else {
        let (codec, lossless) = match kind {
            FileType::Mpeg => ("MPEG 1 Layer 3", Some(false)), FileType::Mpc => ("musepack8", Some(false)),
            FileType::WavPack => ("PCM", None), _ => return Err(Failure("UNSUPPORTED")),
        };
        Technical { container: container.name, codec, lossless, sample_rate_hz: rate, channels, bits_per_sample: bits, duration_seconds: duration, evidence: "bounded-parser-reported" }
    };
    if result.sample_rate_hz == 0 { result.sample_rate_hz = rate; }
    if result.channels == 0 { result.channels = channels; }
    // 固定 CUE demux 的 Musepack 头事实、Opus 48k 时钟保持原合同，不以派生提示替换。
    if container.name != "MPC" && (result.codec != "Opus" && result.sample_rate_hz != rate || result.channels != channels) { return Err(Failure("PARSE_FAILED")); }
    if result.bits_per_sample.is_some() && bits.is_some() && result.bits_per_sample != bits { return Err(Failure("PARSE_FAILED")); }
    if result.bits_per_sample.is_none() { result.bits_per_sample = bits; }
    if result.duration_seconds.is_none() { result.duration_seconds = duration; }
    Ok(result)
}

pub fn process(job: &Job, reader: &mut RemoteReader<'_>, start: Instant) -> Result<Value> {
    let artwork = job.operation == "embedded-artwork";
    log(job, start, "container-check", "正在检查媒体容器");
    let container = formats::inspect(reader, job.dsd_metadata_enabled, job.cue_input_metadata_enabled, artwork)?;
    let mut tags = Tags::default(); let mut technical = container.facts.clone();
    if container.name == "TAK" || container.name == "TTA" {
        if artwork { return Err(Failure("UNSUPPORTED")); }
    } else if container.file_type.is_none() {
        log(job, start, "parse", "正在解析媒体标签");
        for (at, bytes) in &container.id3_ranges { read_id3(reader, *at, *bytes, &mut tags, artwork, artwork || job.include_embedded_artwork)?; }
    } else {
        apply_global_options(GlobalOptions::new().allocation_limit(reader.budget.single_allocation_bytes)
            .preserve_format_specific_items(false).use_custom_resolvers(false));
        // WAVE技术事实只取此前完整fmt/GUID的有界校验；Lofty仍严格读标签，不把有效位宽当容器位宽。
        let read_properties = !artwork && container.name != "WAVE";
        let options = ParseOptions::new().parsing_mode(ParsingMode::Strict).max_junk_bytes(1024).read_tags(true).read_cover_art(artwork || job.include_embedded_artwork).read_properties(read_properties);
        let kind = container.file_type.unwrap();
        reader.seek(SeekFrom::Start(0)).map_err(|_| Failure("PARSE_FAILED"))?;
        log(job, start, "parse", "正在解析媒体标签");
        // 容器检查始终读取真实源；兼容视图只在本次 Lofty 标签读取期间借用。
        let parsed = if container.name == "WAVE" && (!container.wave_tag_lists.is_empty() || container.wave_tail_padding) {
            let size = reader.size;
            let mut view = wave_tag_view::WaveTagView::with_tail(&mut *reader, &container.wave_tag_lists, if container.wave_tail_padding { Some(size) } else { None });
            Probe::with_file_type(&mut view, kind).options(options).read()
        } else { Probe::with_file_type(&mut *reader, kind).options(options).read() };
        let file = parsed
            .map_err(|error| reader.failure.unwrap_or_else(|| match error.kind() { lofty::error::ErrorKind::TooMuchData => Failure("BUDGET_EXCEEDED"), _ => Failure("PARSE_FAILED") }))?;
        reader.check()?;
        // primary_tag 优先，与旧读取器的标准化 common 字段保持一致。
        if let Some(primary) = file.primary_tag() { tags.lofty(std::slice::from_ref(primary), reader, artwork)?; }
        for tag in file.tags() { if !file.primary_tag().is_some_and(|primary| std::ptr::eq(primary, tag)) { tags.lofty(std::slice::from_ref(tag), reader, artwork)?; } }
        if read_properties {
            let properties = file.properties();
            technical = Some(generic_technical(&container, kind, properties.sample_rate().unwrap_or(0), properties.channels().unwrap_or(0), properties.bit_depth(),
                if properties.duration().is_zero() { None } else { Some(properties.duration().as_secs_f64()) })?);
        }
    }
    // 原WAVE primary_tag为ID3；明确可解码的INFO只补缺，不覆盖有效ID3。
    for &(at, length) in &container.wave_info_ranges { let bytes = reader.range(at, length)?; tags.wave_info(&bytes, reader)?; }
    reader.check()?;
    if artwork {
        let items: Vec<Value> = tags.pictures.into_iter().enumerate().map(|(index, picture)| json!({"pictureIndex":index,"base64":STANDARD.encode(picture.bytes),"mime":picture.mime})).collect();
        return Ok(json!({"items":items,"readEvidence":reader.evidence()}));
    }
    let evidence: Vec<Value> = tags.pictures.into_iter().map(|picture| json!({"mime":picture.mime,"bytes":picture.bytes.len(),
        "sha256":format!("{:x}", Sha256::digest(&picture.bytes)),"evidence":"encoded-bytes-magic-and-digest"})).collect();
    if container.name != "TAK" && container.name != "TTA" {
        tags.fields.entry("artists".to_owned()).or_insert_with(|| Value::Array(Vec::new()));
        tags.fields.entry("albumArtists".to_owned()).or_insert_with(|| Value::Array(Vec::new()));
    }
    Ok(json!({"status":"ok","parserVersion":if container.name == "TAK" || container.name == "TTA" {CUE_PARSER_VERSION} else {PARSER_VERSION},
        "fields":tags.fields,"technical":technical.ok_or(Failure("PARSE_FAILED"))?,"coverEvidence":evidence,"readEvidence":reader.evidence()}))
}
