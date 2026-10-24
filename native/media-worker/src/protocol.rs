use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead, Read, Seek, SeekFrom, Write};
use std::time::Instant;

pub const PROTOCOL: u8 = 1;
pub const PARSER_VERSION: &str = "musicbridge-rust-media/v1";
pub const FRAME_BYTES: usize = 12 * 1024 * 1024;
const RPC_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct Failure(pub &'static str);
pub type Result<T> = std::result::Result<T, Failure>;
impl From<io::Error> for Failure { fn from(_: io::Error) -> Self { Self("IO_ERROR") } }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub text_field_bytes: usize,
    pub total_text_bytes: usize,
    pub cover_bytes: usize,
    pub total_read_bytes: usize,
    pub single_read_bytes: usize,
    pub single_allocation_bytes: usize,
    pub total_allocation_bytes: usize,
    pub timeout_ms: u64,
}
impl Budget {
    pub fn validate(&self, artwork: bool) -> Result<()> {
        let maxima = [4096, 64 * 1024, 4 * 1024 * 1024,
            if artwork { 12 * 1024 * 1024 } else { 32 * 1024 * 1024 },
            if artwork { RPC_BYTES } else { 8 * 1024 * 1024 },
            8 * 1024 * 1024, 64 * 1024 * 1024];
        let values = [self.text_field_bytes, self.total_text_bytes, self.cover_bytes, self.total_read_bytes,
            self.single_read_bytes, self.single_allocation_bytes, self.total_allocation_bytes];
        if self.timeout_ms == 0 || self.timeout_ms > 3000 || values.iter().zip(maxima).any(|(v, max)| *v == 0 || *v > max) {
            return Err(Failure("BUDGET_EXCEEDED"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub kind: String,
    pub protocol: u8,
    pub job_id: String,
    pub operation: String,
    pub queue_wait_ms: f64,
    pub slow_threshold_ms: f64,
    pub size: Option<u64>,
    pub budget: Option<Budget>,
    #[serde(default)] pub dsd_metadata_enabled: bool,
    #[serde(default)] pub cue_input_metadata_enabled: bool,
    #[serde(default = "default_true")] pub include_embedded_artwork: bool,
    pub base64: Option<String>,
    pub max_edge: Option<u32>,
    pub max_output_bytes: Option<usize>,
    pub grid_size: Option<u32>,
}
fn default_true() -> bool { true }
impl Job {
    pub fn validate(&self) -> Result<()> {
        if self.kind != "job" || self.protocol != PROTOCOL || self.job_id.len() != 36
            || !self.job_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            || !self.queue_wait_ms.is_finite() || self.queue_wait_ms < 0.0
            || !self.slow_threshold_ms.is_finite() || self.slow_threshold_ms < 0.0 {
            return Err(Failure("WORKER_FAILED"));
        }
        match self.operation.as_str() {
            "metadata" | "embedded-artwork" | "embedded-lyrics" => {
                let size = self.size.ok_or(Failure("PARSE_FAILED"))?;
                if size == 0 || size > 9_007_199_254_740_991 || self.base64.is_some() { return Err(Failure("PARSE_FAILED")); }
                let budget = self.budget.as_ref().ok_or(Failure("BUDGET_EXCEEDED"))?;
                budget.validate(self.operation == "embedded-artwork")?;
                if self.operation == "embedded-lyrics" {
                    if self.dsd_metadata_enabled || self.cue_input_metadata_enabled || self.include_embedded_artwork { return Err(Failure("WORKER_FAILED")); }
                    if budget.total_read_bytes > 512 * 1024 || budget.single_read_bytes > RPC_BYTES || budget.single_allocation_bytes > 128 * 1024
                        || budget.total_allocation_bytes > 8 * 1024 * 1024 || budget.timeout_ms > 2000 { return Err(Failure("BUDGET_EXCEEDED")); }
                }
                Ok(())
            }
            "process-image" => if self.size.is_some() || self.budget.is_some() { Err(Failure("WORKER_FAILED")) } else { Ok(()) },
            _ => Err(Failure("UNSUPPORTED")),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadResult { kind: String, job_id: String, request_id: u64, base64: String }

/** 不调用 read_line 无界增长；协议本身的输入也有硬上限。 */
pub fn read_frame(input: &mut dyn BufRead, maximum: usize) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::with_capacity(1024);
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() { Ok(None) } else { Err(io::Error::new(io::ErrorKind::UnexpectedEof, "协议帧截断")) };
        }
        let end = available.iter().position(|b| *b == b'\n');
        let count = end.map_or(available.len(), |n| n + 1);
        if frame.len().saturating_add(count) > maximum { return Err(io::Error::other("协议帧超过预算")); }
        frame.extend_from_slice(&available[..count]); input.consume(count);
        if end.is_some() { frame.pop(); return Ok(Some(frame)); }
    }
}
pub fn publish(output: &mut dyn Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value)?; output.write_all(b"\n")?; output.flush()
}
pub fn log(job: &Job, start: Instant, stage: &str, message: &str) {
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    let event = json!({"component":"rust-media-worker", "jobId":job.job_id, "stage":stage,
        "elapsedMs":elapsed, "queueWaitMs":job.queue_wait_ms,"slowThresholdMs":job.slow_threshold_ms,
        "slow":elapsed >= job.slow_threshold_ms,"message":message});
    let stderr = io::stderr(); let mut error = stderr.lock(); let _ = publish(&mut error, &event);
}

#[derive(Default)]
pub struct ReadEvidence {
    bytes_read: usize, read_calls: usize, max_read_bytes: usize,
}

/** 无路径、无本机 FD：唯一数据来源是 Node 已核源回调的有界 Read+Seek RPC。 */
pub struct RemoteReader<'a> {
    pub size: u64,
    pub budget: Budget,
    pub started: Instant,
    pub read_ms: f64,
    pub failure: Option<Failure>,
    position: u64,
    job_id: &'a str,
    input: &'a mut dyn BufRead,
    output: &'a mut dyn Write,
    next_request: u64,
    evidence: ReadEvidence,
    reserved_reads: usize,
    // 小读取合并在 Rust 端；缓存不跨任务保留。
    cache: Vec<u8>,
    cache_at: u64,
    // 歌词帧必须精确随机读取；不能为小header把data/APIC顺带预读。其他操作保持原64KiB缓存。
    exact_ranges: bool,
}
impl<'a> RemoteReader<'a> {
    pub fn new(job: &'a Job, input: &'a mut dyn BufRead, output: &'a mut dyn Write, started: Instant) -> Result<Self> {
        Ok(Self { size: job.size.ok_or(Failure("PARSE_FAILED"))?, budget: job.budget.clone().ok_or(Failure("BUDGET_EXCEEDED"))?,
            started, read_ms: 0.0, failure: None, position: 0, job_id: &job.job_id, input, output, next_request: 1,
            evidence: ReadEvidence::default(), reserved_reads: 0, cache: Vec::new(), cache_at: 0, exact_ranges: job.operation == "embedded-lyrics" })
    }
    pub fn check(&mut self) -> Result<()> {
        if let Some(error) = self.failure { return Err(error); }
        if self.started.elapsed().as_millis() >= u128::from(self.budget.timeout_ms) {
            self.failure = Some(Failure("TIMEOUT")); return Err(Failure("TIMEOUT"));
        }
        Ok(())
    }
    pub fn reserve(&mut self, bytes: usize) -> Result<()> {
        self.check()?;
        if bytes > self.budget.single_allocation_bytes || crate::allocation::used().saturating_add(bytes) > self.budget.total_allocation_bytes {
            self.failure = Some(Failure("BUDGET_EXCEEDED")); return Err(Failure("BUDGET_EXCEEDED"));
        }
        Ok(())
    }
    pub fn evidence(&self) -> Value {
        json!({"bytesRead":self.evidence.bytes_read,"readCalls":self.evidence.read_calls,
            "maxReadBytes":self.evidence.max_read_bytes,"allocationBytes":crate::allocation::used(),
            "elapsedMs":self.started.elapsed().as_secs_f64()*1000.0,"wholeAudioHash":false,"wholeAudioDecode":false})
    }
    pub fn range(&mut self, at: u64, count: usize) -> Result<Vec<u8>> {
        if at > self.size || count as u64 > self.size - at { return Err(Failure("PARSE_FAILED")); }
        self.reserve(count)?;
        if self.exact_ranges {
            let mut bytes = Vec::with_capacity(count);
            while bytes.len() < count {
                let length = (count - bytes.len()).min(RPC_BYTES).min(self.budget.single_read_bytes);
                let part = self.rpc(at + bytes.len() as u64, length)?;
                if part.is_empty() { return Err(Failure("PARSE_FAILED")); }
                bytes.extend_from_slice(&part);
            }
            return Ok(bytes);
        }
        self.seek(SeekFrom::Start(at)).map_err(|_| self.failure.unwrap_or(Failure("PARSE_FAILED")))?;
        let mut bytes = vec![0; count];
        self.read_exact(&mut bytes).map_err(|_| self.failure.unwrap_or(Failure("PARSE_FAILED")))?; Ok(bytes)
    }
    fn rpc(&mut self, at: u64, count: usize) -> Result<Vec<u8>> {
        self.check()?;
        if count == 0 || count > RPC_BYTES.min(self.budget.single_read_bytes)
            || self.reserved_reads.saturating_add(count) > self.budget.total_read_bytes || self.next_request > 16_384 {
            return Err(Failure("BUDGET_EXCEEDED"));
        }
        self.reserved_reads += count;
        let _transport = crate::allocation::TransportBudget::enter();
        let request = self.next_request; self.next_request += 1;
        let started = Instant::now();
        publish(self.output, &json!({"kind":"read","jobId":self.job_id,"requestId":request,"offset":at,"length":count}))?;
        let frame = read_frame(self.input, ((count + 2) / 3) * 4 + 1024)?.ok_or(Failure("WORKER_FAILED"))?;
        let response: ReadResult = serde_json::from_slice(&frame).map_err(|_| Failure("WORKER_FAILED"))?;
        if response.kind != "read-result" || response.job_id != self.job_id || response.request_id != request
            || response.base64.len() > ((count + 2) / 3) * 4 { return Err(Failure("WORKER_FAILED")); }
        let bytes = STANDARD.decode(response.base64).map_err(|_| Failure("WORKER_FAILED"))?;
        if bytes.len() > count { return Err(Failure("WORKER_FAILED")); }
        self.read_ms += started.elapsed().as_secs_f64() * 1000.0;
        self.evidence.bytes_read += bytes.len(); self.evidence.read_calls += 1;
        self.evidence.max_read_bytes = self.evidence.max_read_bytes.max(count);
        self.check()?; Ok(bytes)
    }
}
impl Read for RemoteReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.position == self.size { return Ok(0); }
        self.check().map_err(|_| io::Error::other("读取期限或预算已用尽"))?;
        if self.position < self.cache_at || self.position >= self.cache_at + self.cache.len() as u64 {
            // 预读最多 64KiB，且不能越过当前预算；大文件不会整件送到 Node 或 Rust 内存。
            let available = (self.size - self.position).min(RPC_BYTES as u64) as usize;
            let count = available.min(self.budget.single_read_bytes).min(self.budget.single_allocation_bytes).min(self.budget.total_read_bytes.saturating_sub(self.reserved_reads));
            self.cache_at = self.position;
            match self.rpc(self.position, count) {
                Ok(bytes) => self.cache = bytes,
                Err(error) => { self.failure = Some(error); return Err(io::Error::other("媒体有界读取失败")); }
            }
            if self.cache.is_empty() { return Ok(0); }
        }
        let offset = (self.position - self.cache_at) as usize;
        let count = buffer.len().min(self.cache.len() - offset);
        buffer[..count].copy_from_slice(&self.cache[offset..offset + count]); self.position += count as u64; Ok(count)
    }
}
impl Seek for RemoteReader<'_> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.check().map_err(|_| io::Error::other("读取期限或预算已用尽"))?;
        let next = match from { SeekFrom::Start(n) => i128::from(n), SeekFrom::Current(n) => i128::from(self.position) + i128::from(n), SeekFrom::End(n) => i128::from(self.size) + i128::from(n) };
        if next < 0 || next > i128::from(self.size) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "定位超出媒体边界")); }
        self.position = next as u64; Ok(self.position)
    }
}
