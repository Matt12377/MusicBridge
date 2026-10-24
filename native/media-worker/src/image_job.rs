use crate::protocol::{Failure, Job, Result, log};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Limits, codecs::jpeg::JpegEncoder, imageops::FilterType};
use serde_json::{Value, json};
use std::io::{self, Cursor, Write};
use std::time::Instant;

const INPUT_BYTES: usize = 4 * 1024 * 1024;
const METADATA_BYTES: usize = 256 * 1024;
const DECODE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EDGE: u32 = 4096;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;
const GRID_BYTES: usize = 256 * 1024;

fn u32be(bytes: &[u8]) -> u32 { u32::from_be_bytes(bytes[..4].try_into().unwrap()) }

/** 在解码器之前排除 APNG、MPO、拼接图及无界元数据；完整CRC仍由原准入层核实。 */
fn image_structure(bytes: &[u8]) -> Result<ImageFormat> {
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(&b"WEBP"[..]) {
        if bytes.len() < 20 || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize != bytes.len() - 8 { return Err(Failure("PARSE_FAILED")); }
        let mut at = 12usize; let mut metadata = 0usize; let mut image = false;
        for _ in 0..16_384 {
            if at == bytes.len() { return if image { Ok(ImageFormat::WebP) } else { Err(Failure("PARSE_FAILED")) }; }
            if at + 8 > bytes.len() { return Err(Failure("PARSE_FAILED")); }
            let kind = &bytes[at..at + 4]; let n = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            let next = at.checked_add(8).and_then(|v| v.checked_add(n)).and_then(|v| v.checked_add(n % 2)).filter(|v| *v <= bytes.len()).ok_or(Failure("PARSE_FAILED"))?;
            if kind == b"ANIM" || kind == b"ANMF" || kind == b"VP8X" && (n != 10 || bytes[at + 8] & 2 != 0) { return Err(Failure("UNSUPPORTED")); }
            if kind == b"VP8 " || kind == b"VP8L" { if image { return Err(Failure("UNSUPPORTED")); } image = true; }
            else if kind != b"VP8X" && kind != b"ALPH" { metadata = metadata.saturating_add(n); if metadata > METADATA_BYTES { return Err(Failure("BUDGET_EXCEEDED")); } }
            at = next;
        }
        return Err(Failure("BUDGET_EXCEEDED"));
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        if bytes.len() < 8 { return Err(Failure("PARSE_FAILED")); }
        let little = bytes[0] == b'I';
        let u16at = |at: usize| -> Result<u16> { let b: [u8;2] = bytes.get(at..at + 2).ok_or(Failure("PARSE_FAILED"))?.try_into().unwrap(); Ok(if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) }) };
        let u32at = |at: usize| -> Result<u32> { let b: [u8;4] = bytes.get(at..at + 4).ok_or(Failure("PARSE_FAILED"))?.try_into().unwrap(); Ok(if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) }) };
        let ifd = u32at(4)? as usize; if ifd < 8 { return Err(Failure("PARSE_FAILED")); }
        let count = usize::from(u16at(ifd)?); if count == 0 || count > 4096 { return Err(Failure("BUDGET_EXCEEDED")); }
        let next_ifd = ifd.checked_add(2 + count * 12).filter(|n| *n <= bytes.len().saturating_sub(4)).ok_or(Failure("PARSE_FAILED"))?;
        if u32at(next_ifd)? != 0 { return Err(Failure("UNSUPPORTED")); }
        let mut metadata = count * 12 + 6;
        for index in 0..count {
            let at = ifd + 2 + index * 12; let tag = u16at(at)?; let kind = u16at(at + 2)?; let entries = u32at(at + 4)? as usize;
            if tag == 330 { return Err(Failure("UNSUPPORTED")); }
            let unit = match kind { 1 | 2 | 6 | 7 => 1, 3 | 8 => 2, 4 | 9 | 11 => 4, 5 | 10 | 12 => 8, _ => return Err(Failure("UNSUPPORTED")) };
            let n = entries.checked_mul(unit).ok_or(Failure("BUDGET_EXCEEDED"))?;
            if n > 4 { let offset = u32at(at + 8)? as usize; if offset > bytes.len() || n > bytes.len() - offset { return Err(Failure("PARSE_FAILED")); } metadata = metadata.saturating_add(n); }
            if metadata > METADATA_BYTES { return Err(Failure("BUDGET_EXCEEDED")); }
        }
        return Ok(ImageFormat::Tiff);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let mut at = 8usize; let mut metadata = 0usize; let mut seen_header = false; let mut seen_data = false;
        for count in 0..16_384 {
            if at + 12 > bytes.len() { return Err(Failure("PARSE_FAILED")); }
            let n = u32be(&bytes[at..]) as usize; let kind = &bytes[at + 4..at + 8];
            let end = at.checked_add(12).and_then(|v| v.checked_add(n)).filter(|v| *v <= bytes.len()).ok_or(Failure("PARSE_FAILED"))?;
            if kind == b"acTL" || kind == b"fcTL" || kind == b"fdAT" { return Err(Failure("UNSUPPORTED")); }
            if kind == b"IHDR" {
                if count != 0 || seen_header || n != 13 { return Err(Failure("PARSE_FAILED")); }
                seen_header = true;
            } else if kind == b"IDAT" { seen_data = true; }
            else if kind == b"IEND" {
                return if n == 0 && end == bytes.len() && seen_header && seen_data { Ok(ImageFormat::Png) } else { Err(Failure("PARSE_FAILED")) };
            } else {
                metadata = metadata.saturating_add(n);
                if metadata > METADATA_BYTES { return Err(Failure("BUDGET_EXCEEDED")); }
            }
            at = end;
        }
        return Err(Failure("BUDGET_EXCEEDED"));
    }
    if !bytes.starts_with(&[0xff, 0xd8, 0xff]) { return Err(Failure("UNSUPPORTED")); }
    let mut at = 2usize; let mut metadata = 0usize; let mut scans = 0usize;
    for _ in 0..65_536 {
        if at >= bytes.len() || bytes[at] != 0xff { return Err(Failure("PARSE_FAILED")); }
        while at < bytes.len() && bytes[at] == 0xff { at += 1; }
        let marker = *bytes.get(at).ok_or(Failure("PARSE_FAILED"))?; at += 1;
        if marker == 0xd9 { return if scans > 0 && at == bytes.len() { Ok(ImageFormat::Jpeg) } else { Err(Failure("PARSE_FAILED")) }; }
        if marker == 0xd8 || marker == 0 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) { return Err(Failure("PARSE_FAILED")); }
        let length = bytes.get(at..at + 2).ok_or(Failure("PARSE_FAILED"))?;
        let n = u16::from_be_bytes(length.try_into().unwrap()) as usize;
        if n < 2 || at + n > bytes.len() { return Err(Failure("PARSE_FAILED")); }
        if (0xe0..=0xef).contains(&marker) || marker == 0xfe {
            metadata = metadata.saturating_add(n - 2);
            if metadata > METADATA_BYTES { return Err(Failure("BUDGET_EXCEEDED")); }
            if marker == 0xe2 && bytes[at + 2..at + n].starts_with(b"MPF\0") { return Err(Failure("UNSUPPORTED")); }
        }
        at += n;
        if marker == 0xda {
            scans += 1;
            // 跳过熵编码，仅检查 marker 边界，不在结构准入中重复解码像素。
            loop {
                if at + 1 >= bytes.len() { return Err(Failure("PARSE_FAILED")); }
                if bytes[at] != 0xff { at += 1; continue; }
                let mut next = at + 1; while next < bytes.len() && bytes[next] == 0xff { next += 1; }
                let code = *bytes.get(next).ok_or(Failure("PARSE_FAILED"))?;
                if code == 0 || (0xd0..=0xd7).contains(&code) { at = next + 1; continue; }
                break;
            }
        }
    }
    Err(Failure("BUDGET_EXCEEDED"))
}

struct BoundedOutput { bytes: Vec<u8>, limit: usize }
impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > self.limit { return Err(io::Error::other("JPEG 输出超过预算")); }
        self.bytes.extend_from_slice(bytes); Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

fn variant(image: &DynamicImage, edge: u32, maximum: usize, start: Instant, fixed_dimensions: bool) -> Result<Value> {
    let (width, height) = image.dimensions();
    let mut edge = edge.min(width.max(height));
    for _ in 0..12 {
        let resized = image.resize(edge, edge, FilterType::Triangle);
        let mut rgba = resized.to_rgba8();
        for pixel in rgba.pixels_mut() {
            let alpha = u32::from(pixel.0[3]);
            for channel in 0..3 { pixel.0[channel] = ((u32::from(pixel.0[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8; }
            pixel.0[3] = 255;
        }
        let rgb = DynamicImage::ImageRgba8(rgba).to_rgb8();
        for quality in [88, 78, 66, 54, 40, 28] {
            if start.elapsed().as_millis() >= 3000 { return Err(Failure("TIMEOUT")); }
            let mut output = BoundedOutput { bytes: Vec::with_capacity(maximum.min(64 * 1024)), limit: maximum };
            if JpegEncoder::new_with_quality(&mut output, quality).encode_image(&rgb).is_ok() {
                return Ok(json!({"base64":STANDARD.encode(output.bytes),"mime":"image/jpeg","width":rgb.width(),"height":rgb.height()}));
            }
        }
        if fixed_dimensions || edge <= 16 { break; }
        edge = (edge * 3 / 4).max(1);
    }
    Err(Failure("BUDGET_EXCEEDED"))
}

pub fn process(job: &Job, start: Instant) -> Result<Value> {
    let encoded = job.base64.as_deref().ok_or(Failure("PARSE_FAILED"))?;
    if encoded.len() > ((INPUT_BYTES + 2) / 3) * 4 { return Err(Failure("BUDGET_EXCEEDED")); }
    let bytes = STANDARD.decode(encoded).map_err(|_| Failure("PARSE_FAILED"))?;
    if bytes.is_empty() || bytes.len() > INPUT_BYTES { return Err(Failure("BUDGET_EXCEEDED")); }
    let max_edge = job.max_edge.ok_or(Failure("PARSE_FAILED"))?;
    let max_output = job.max_output_bytes.ok_or(Failure("PARSE_FAILED"))?;
    let grid_edge = job.grid_size.unwrap_or(336);
    if max_edge == 0 || max_edge > MAX_EDGE || max_output == 0 || max_output > INPUT_BYTES || grid_edge > MAX_EDGE { return Err(Failure("BUDGET_EXCEEDED")); }
    let format = image_structure(&bytes)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default(); limits.max_image_width = Some(MAX_EDGE); limits.max_image_height = Some(MAX_EDGE); limits.max_alloc = Some(DECODE_BYTES);
    reader.limits(limits);
    log(job, start, "decode", "正在解码封面");
    let mut decoder = reader.into_decoder().map_err(|_| Failure("PARSE_FAILED"))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE || u64::from(width) * u64::from(height) > MAX_PIXELS || decoder.total_bytes() > DECODE_BYTES { return Err(Failure("BUDGET_EXCEEDED")); }
    let orientation = decoder.orientation().map_err(|_| Failure("PARSE_FAILED"))?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| Failure("PARSE_FAILED"))?;
    image.apply_orientation(orientation);
    log(job, start, "encode", "正在生成封面缓存");
    let mut display = variant(&image, max_edge, max_output, start, false)?;
    let mime = match format { ImageFormat::Png => "image/png", ImageFormat::Jpeg => "image/jpeg", ImageFormat::Tiff => "image/tiff", ImageFormat::WebP => "image/webp", _ => return Err(Failure("UNSUPPORTED")) };
    display["original"] = json!({"width":width,"height":height,"mime":mime});
    if grid_edge != 0 { display["grid"] = variant(&image, grid_edge, GRID_BYTES.min(max_output), start, false)?; }
    if format == ImageFormat::Tiff || format == ImageFormat::WebP { display["compatible"] = variant(&image, image.width().max(image.height()), INPUT_BYTES, start, true)?; }
    Ok(display)
}
