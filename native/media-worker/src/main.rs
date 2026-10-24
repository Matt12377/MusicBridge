mod allocation;
mod formats;
mod image_job;
mod metadata;
mod embedded_lyrics;
mod protocol;

use protocol::{FRAME_BYTES, Failure, Job, PARSER_VERSION, PROTOCOL, RemoteReader, log, publish, read_frame};
use serde_json::json;
use std::io::{self, BufReader};
use std::time::Instant;

fn main() {
    // panic 的内容可能包含第三方 parser 数据；终端只保留固定结构化诊断。
    std::panic::set_hook(Box::new(|_| {}));
    if serve().is_err() { std::process::exit(2); }
}
fn serve() -> io::Result<()> {
    let input = io::stdin(); let output = io::stdout();
    let mut input = BufReader::with_capacity(64 * 1024, input.lock()); let mut output = output.lock();
    publish(&mut output, &json!({"kind":"ready","protocol":PROTOCOL,"parserVersion":PARSER_VERSION}))?;
    while let Some(frame) = read_frame(&mut input, FRAME_BYTES)? {
        let job: Job = serde_json::from_slice(&frame).map_err(|_| io::Error::other("媒体任务协议无效"))?;
        let started = Instant::now();
        if let Err(error) = job.validate() {
            publish(&mut output, &json!({"kind":"result","jobId":job.job_id,"ok":false,"code":error.0}))?; continue;
        }
        log(&job, started, "start", "媒体任务已开始");
        let (result, read_ms) = if job.operation == "process-image" {
            (image_job::process(&job, started), 0.0)
        } else {
            let budget = job.budget.as_ref().ok_or_else(|| io::Error::other("媒体读取预算缺失"))?;
            let _allocation = allocation::TaskBudget::begin(budget.single_allocation_bytes, budget.total_allocation_bytes);
            let mut reader = RemoteReader::new(&job, &mut input, &mut output, started).map_err(|_| io::Error::other("媒体读取任务无效"))?;
            let result = if job.operation == "embedded-lyrics" { embedded_lyrics::process(&job, &mut reader, started) } else { metadata::process(&job, &mut reader, started) }; let read_ms = reader.read_ms;
            // Reader 在最终结果之前销毁；成功后没有 source、FD 或跨任务读取缓存。
            (result, read_ms)
        };
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let result = if elapsed_ms >= job.budget.as_ref().map_or(3000.0, |b| b.timeout_ms as f64) { Err(Failure("TIMEOUT")) } else { result };
        log(&job, started, "complete", if result.is_ok() { "媒体任务已完成" } else { "媒体任务已收口" });
        match result {
            Ok(value) => publish(&mut output, &json!({"kind":"result","jobId":job.job_id,"ok":true,"value":value,
                "performance":{"readMs":read_ms,"parseMs":(elapsed_ms-read_ms).max(0.0)}}))?,
            Err(error) => publish(&mut output, &json!({"kind":"result","jobId":job.job_id,"ok":false,"code":error.0}))?,
        }
    }
    Ok(())
}
