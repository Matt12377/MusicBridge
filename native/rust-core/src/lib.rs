//! RUST-001：仅持有调用方提供的公开收藏快照，不访问文件、网络或设备。
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fmt;
use std::io::{self, BufRead, Write};

pub const MAX_FRAME_BYTES: usize = 4_194_304;
pub const MAX_MODELS: usize = 2_000;
pub const MAX_REQUESTS: usize = 65_536;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidRequest,
    UnsupportedOperation,
    UnsupportedCommand,
    UnsupportedFilter,
    ScopeMismatch,
    CapacityExceeded,
    NotReady,
    Closing,
    ProtocolError,
}
impl ErrorCode {
    fn value(self) -> Value {
        let (code, message) = match self {
            Self::InvalidRequest => ("INVALID_REQUEST", "请求不符合只读合同"),
            Self::UnsupportedOperation => ("UNSUPPORTED_OPERATION", "不支持此进程操作"),
            Self::UnsupportedCommand => ("UNSUPPORTED_COMMAND", "只读进程不支持此命令"),
            Self::UnsupportedFilter => ("UNSUPPORTED_FILTER", "只读快照不支持筛选"),
            Self::ScopeMismatch => ("SCOPE_MISMATCH", "快照身份不匹配"),
            Self::CapacityExceeded => ("CAPACITY_EXCEEDED", "请求超过容量限制"),
            Self::NotReady => ("NOT_READY", "只读快照尚未就绪"),
            Self::Closing => ("CLOSING", "只读进程正在关闭"),
            Self::ProtocolError => ("PROTOCOL_ERROR", "只读进程协议无效"),
        };
        json!({"code": code, "message": message})
    }
}

fn keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.keys().all(|key| allowed.contains(&key.as_str())))
}
fn integer(value: &Value, min: u64, max: u64) -> Option<u64> {
    let n = value.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n >= min as f64 && n <= max as f64).then_some(n as u64)
}
fn uuid(value: &Value, v4: bool, insensitive: bool) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_digit()
                    || (b'a'..=b'f').contains(c)
                    || (insensitive && (b'A'..=b'F').contains(c))
            }
        })
        && (if v4 {
            b[14] == b'4'
        } else {
            (b'1'..=b'8').contains(&b[14])
        })
        && b"89ab".contains(&b[19].to_ascii_lowercase())
}
fn text(value: &Value, empty: bool, max: usize) -> bool {
    value.as_str().is_some_and(|s| {
        s.encode_utf16().count() <= max
            && (empty || !s.trim_matches(js_whitespace).is_empty())
            && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    })
}
// 与 JavaScript trim 对齐；不把 Unicode NEL 等额外字符当成空白。
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn one_of(value: &Value, allowed: &[&str]) -> bool {
    value.as_str().is_some_and(|s| allowed.contains(&s))
}
fn physical_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        let b = s.as_bytes();
        (10..=14).contains(&b.len())
            && &b[..3] == b"MB-"
            && b"CD".contains(&b[3])
            && b[4] == b'-'
            && b[5..].iter().all(u8::is_ascii_digit)
    })
}
fn photo(value: &Value, model_id: &Value) -> bool {
    keys(
        value,
        &["id", "modelId", "physicalId", "width", "height", "source"],
    ) && uuid(&value["id"], true, false)
        && uuid(&value["modelId"], true, false)
        && &value["modelId"] == model_id
        && value.get("physicalId").is_none_or(physical_id)
        && integer(&value["width"], 1, 1200).is_some()
        && integer(&value["height"], 1, 1200).is_some()
        && value["source"] == "user-photo"
}
pub fn is_collection_model(v: &Value) -> bool {
    let fields = [
        "brand",
        "name",
        "edition",
        "year",
        "format",
        "tapeType",
        "identification",
        "id",
        "collectorPolicy",
        "minimumSealedReserve",
        "revision",
        "lengths",
        "counts",
        "featuredPhoto",
        "photoCount",
    ];
    if !keys(v, &fields)
        || !uuid(&v["id"], true, false)
        || !text(&v["brand"], true, 120)
        || !text(&v["name"], true, 120)
        || !text(&v["edition"], true, 120)
        || !(v.get("year").is_some_and(Value::is_null) || integer(&v["year"], 1900, 2200).is_some())
        || !(v["format"] == "dat" && v["tapeType"] == "dat"
            || v["format"] == "cassette"
                && one_of(&v["tapeType"], &["I", "II", "III", "IV", "unknown"]))
        || !one_of(
            &v["identification"],
            &["unidentified", "partial", "candidate", "verified"],
        )
        || (v["identification"] == "verified"
            && !(text(&v["brand"], false, 120)
                && text(&v["name"], false, 120)
                && text(&v["edition"], false, 120)))
        || !one_of(
            &v["collectorPolicy"],
            &["normal", "prefer-opened", "preserve-sealed", "collector"],
        )
        || integer(&v["minimumSealedReserve"], 0, 1_000_000).is_none()
        || integer(&v["revision"], 1, 1_000_000).is_none()
        || !v["lengths"].as_array().is_some_and(|a| {
            a.len() <= 100
                && a.iter()
                    .all(|n| n.is_null() || integer(n, 1, 360).is_some())
        })
        || v.get("photoCount")
            .is_some_and(|n| integer(n, 0, 24).is_none())
        || !v.get("featuredPhoto").is_none_or(|p| photo(p, &v["id"]))
    {
        return false;
    }
    let count_fields = [
        "total",
        "sealedBlank",
        "openedBlank",
        "legacyUsed",
        "recorded",
        "reserved",
        "unavailable",
        "unknown",
    ];
    let counts = &v["counts"];
    keys(counts, &count_fields)
        && count_fields
            .iter()
            .all(|k| integer(&counts[k], 0, 1_000_000).is_some())
        && integer(&counts["total"], 0, 1_000_000)
            == Some(
                count_fields[1..]
                    .iter()
                    .map(|k| integer(&counts[k], 0, 1_000_000).unwrap_or(0))
                    .sum(),
            )
}

// serde_json 的普通 Value 会覆盖重复字段；私有协议在所有嵌套层拒绝重复字段。
struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("合法 JSON 值")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| StrictValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("数值无效"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                self.visit_unit()
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(StrictValue(v)) = a.next_element()? {
                    values.push(v);
                }
                Ok(StrictValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if values.contains_key(&k) {
                        return Err(de::Error::custom("字段重复"));
                    }
                    values.insert(k, a.next_value::<StrictValue>()?.0);
                }
                Ok(StrictValue(Value::Object(values)))
            }
        }
        d.deserialize_any(StrictVisitor)
    }
}
fn parse(frame: &[u8]) -> Result<Value, ErrorCode> {
    serde_json::from_slice::<StrictValue>(frame)
        .map(|v| v.0)
        .map_err(|_| ErrorCode::ProtocolError)
}

pub struct Sidecar {
    identity: Option<(Value, Value, Value)>,
    models: Vec<Value>,
    next_sequence: u64,
    requests: HashSet<String>,
    ready: bool,
    closed: bool,
}
impl Default for Sidecar {
    fn default() -> Self {
        Self {
            identity: None,
            models: Vec::new(),
            next_sequence: 1,
            requests: HashSet::new(),
            ready: false,
            closed: false,
        }
    }
}
pub struct Reply {
    pub value: Value,
    pub exit: bool,
    pub failed: bool,
}
impl Sidecar {
    pub fn new() -> Self {
        Self {
            next_sequence: 1,
            ..Self::default()
        }
    }
    pub fn handle(&mut self, frame: &[u8]) -> Result<Reply, ErrorCode> {
        let outcome = self.handle_inner(frame);
        if outcome.as_ref().map_or(true, |reply| reply.exit) {
            self.closed = true;
            self.models.clear();
            self.identity = None;
        }
        outcome
    }
    fn handle_inner(&mut self, frame: &[u8]) -> Result<Reply, ErrorCode> {
        if self.closed {
            return Err(ErrorCode::Closing);
        }
        if frame.len() > MAX_FRAME_BYTES {
            return Err(ErrorCode::CapacityExceeded);
        }
        let v = parse(frame)?;
        let envelope = [
            "protocolVersion",
            "requestId",
            "epoch",
            "datasetId",
            "snapshotId",
            "sequence",
            "operation",
            "payload",
        ];
        if !keys(&v, &envelope)
            || v.as_object().is_none_or(|o| o.len() != envelope.len())
            || integer(&v["protocolVersion"], 1, 1).is_none()
            || !["requestId", "epoch", "datasetId", "snapshotId"]
                .iter()
                .all(|k| uuid(&v[k], true, false))
            || integer(&v["sequence"], 1, MAX_SAFE_INTEGER).is_none()
            || !text(&v["operation"], false, 64)
            || !v["payload"].is_object()
        {
            return Err(ErrorCode::ProtocolError);
        }
        let sequence = integer(&v["sequence"], 1, MAX_SAFE_INTEGER).unwrap();
        if sequence != self.next_sequence
            || self.requests.contains(v["requestId"].as_str().unwrap())
        {
            return Err(ErrorCode::ProtocolError);
        }
        if self.requests.len() >= MAX_REQUESTS
            || (sequence == MAX_REQUESTS as u64 && v["operation"] != "close")
        {
            return Ok(self.reply(&v, Err(ErrorCode::CapacityExceeded), true));
        }
        self.next_sequence += 1;
        self.requests
            .insert(v["requestId"].as_str().unwrap().to_owned());
        if let Some((epoch, dataset, snapshot)) = &self.identity
            && (epoch != &v["epoch"] || dataset != &v["datasetId"] || snapshot != &v["snapshotId"])
        {
            return Ok(self.reply(&v, Err(ErrorCode::ScopeMismatch), true));
        }
        let payload = &v["payload"];
        let result = match v["operation"].as_str().unwrap() {
            "prepare" => {
                if self.identity.is_some()
                    || !keys(payload, &["models"])
                    || !payload["models"].is_array()
                {
                    Err(ErrorCode::InvalidRequest)
                } else {
                    let models = payload["models"].as_array().unwrap();
                    if models.len() > MAX_MODELS {
                        return Ok(self.reply(&v, Err(ErrorCode::CapacityExceeded), true));
                    }
                    let mut ids = HashSet::new();
                    if !models
                        .iter()
                        .all(|m| is_collection_model(m) && ids.insert(m["id"].as_str().unwrap()))
                    {
                        Err(ErrorCode::InvalidRequest)
                    } else {
                        self.models = models.clone();
                        self.identity = Some((
                            v["epoch"].clone(),
                            v["datasetId"].clone(),
                            v["snapshotId"].clone(),
                        ));
                        Ok(
                            json!({"epoch": v["epoch"], "datasetId": v["datasetId"], "snapshotId": v["snapshotId"], "readOnly": true, "capabilities": ["collection.list"], "modelCount": models.len()}),
                        )
                    }
                }
            }
            "commitBoot" => {
                if !keys(payload, &[]) {
                    Err(ErrorCode::InvalidRequest)
                } else if self.identity.is_none() {
                    Err(ErrorCode::NotReady)
                } else {
                    self.ready = true;
                    Ok(Value::Null)
                }
            }
            "dispatch" => {
                if !self.ready {
                    Err(ErrorCode::NotReady)
                } else {
                    self.dispatch(payload)
                }
            }
            "close" => {
                if !keys(payload, &[]) {
                    Err(ErrorCode::InvalidRequest)
                } else {
                    self.models.clear();
                    self.identity = None;
                    self.closed = true;
                    Ok(Value::Null)
                }
            }
            _ => Err(ErrorCode::UnsupportedOperation),
        };
        Ok(self.reply(&v, result, self.closed))
    }
    fn reply(&self, v: &Value, result: Result<Value, ErrorCode>, exit: bool) -> Reply {
        let mut response = Map::new();
        for k in [
            "protocolVersion",
            "requestId",
            "epoch",
            "datasetId",
            "snapshotId",
            "sequence",
            "operation",
        ] {
            response.insert(k.into(), v[k].clone());
        }
        let failed = exit && result.is_err();
        response.insert("ok".into(), Value::Bool(result.is_ok()));
        match result {
            Ok(result) => {
                response.insert("result".into(), result);
            }
            Err(error) => {
                response.insert("error".into(), error.value());
            }
        }
        Reply {
            value: Value::Object(response),
            exit,
            failed,
        }
    }
    fn dispatch(&self, payload: &Value) -> Result<Value, ErrorCode> {
        if !keys(payload, &["request"]) {
            return Err(ErrorCode::InvalidRequest);
        }
        let r = &payload["request"];
        if !keys(
            r,
            &[
                "version",
                "id",
                "command",
                "payload",
                "expectedDatasetId",
                "readContext",
                "performanceTrace",
            ],
        ) || integer(&r["version"], 1, 1).is_none()
            || !r["id"].as_str().is_some_and(|s| {
                !s.trim_matches(js_whitespace).is_empty() && s.encode_utf16().count() <= 128
            })
            || !r["command"].is_string()
            || !r["payload"].is_object()
        {
            return Err(ErrorCode::InvalidRequest);
        }
        if let Some(dataset) = r.get("expectedDatasetId") {
            if !uuid(dataset, false, false) {
                return Err(ErrorCode::InvalidRequest);
            }
            if dataset != &self.identity.as_ref().unwrap().1 {
                return Err(ErrorCode::ScopeMismatch);
            }
        }
        if let Some(trace) = r.get("performanceTrace")
            && (!keys(trace, &["traceId", "requestId", "parentRequestId"])
                || !uuid(&trace["traceId"], false, true)
                || !uuid(&trace["requestId"], false, true)
                || !trace
                    .get("parentRequestId")
                    .is_none_or(|v| uuid(v, false, true)))
        {
            return Err(ErrorCode::InvalidRequest);
        }
        if r["command"] != "collection.list" {
            return Err(ErrorCode::UnsupportedCommand);
        }
        // 现有公开 validator 不准入 collection.list 的 LibraryReadContext。
        if r.get("readContext").is_some() {
            return Err(ErrorCode::InvalidRequest);
        }
        let p = &r["payload"];
        if !keys(p, &["page", "filter"]) || !keys(&p["page"], &["offset", "limit"]) {
            return Err(ErrorCode::InvalidRequest);
        }
        let offset =
            integer(&p["page"]["offset"], 0, 1_000_000).ok_or(ErrorCode::InvalidRequest)? as usize;
        let limit = integer(&p["page"]["limit"], 1, 100).ok_or(ErrorCode::InvalidRequest)? as usize;
        if let Some(filter) = p.get("filter") {
            if !keys(filter, &["query", "brand", "decade", "stockState"])
                || filter.get("query").is_some_and(|v| !text(v, true, 120))
                || filter.get("brand").is_some_and(|v| !text(v, true, 120))
                || filter.get("decade").is_some_and(|v| {
                    v != "unknown" && integer(v, 1900, 2200).is_none_or(|n| n % 10 != 0)
                })
                || filter.get("stockState").is_some_and(|v| {
                    !one_of(v, &["identified", "needs-review", "blank", "recorded"])
                })
            {
                return Err(ErrorCode::InvalidRequest);
            }
            if !filter.as_object().unwrap().is_empty() {
                return Err(ErrorCode::UnsupportedFilter);
            }
        }
        let items = if offset >= self.models.len() {
            &[][..]
        } else {
            &self.models[offset..offset.saturating_add(limit).min(self.models.len())]
        };
        Ok(
            json!({"items": items, "offset": offset, "limit": limit, "total": self.models.len(), "hasMore": offset + items.len() < self.models.len()}),
        )
    }
}

pub fn run<R: BufRead, W: Write>(mut input: R, mut output: W) -> Result<(), ErrorCode> {
    let mut sidecar = Sidecar::new();
    let mut frame = Vec::new();
    loop {
        // fill_buf/consume 在追加前检查上限，避免 read_until 为超大帧无限分配。
        let chunk = input.fill_buf().map_err(|_| ErrorCode::ProtocolError)?;
        if chunk.is_empty() {
            return if frame.is_empty() {
                Ok(())
            } else {
                Err(ErrorCode::ProtocolError)
            };
        }
        let newline = chunk.iter().position(|b| *b == b'\n');
        let size = newline.unwrap_or(chunk.len());
        if frame.len() + size > MAX_FRAME_BYTES {
            return Err(ErrorCode::CapacityExceeded);
        }
        frame.extend_from_slice(&chunk[..size]);
        input.consume(size + usize::from(newline.is_some()));
        if newline.is_none() {
            continue;
        }
        let reply = sidecar.handle(&frame)?;
        let bytes = serde_json::to_vec(&reply.value).map_err(|_| ErrorCode::ProtocolError)?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(ErrorCode::CapacityExceeded);
        }
        output
            .write_all(&bytes)
            .and_then(|()| output.write_all(b"\n"))
            .and_then(|()| output.flush())
            .map_err(|_| ErrorCode::ProtocolError)?;
        frame.clear();
        if reply.exit {
            return if reply.failed {
                Err(ErrorCode::ProtocolError)
            } else {
                Ok(())
            };
        }
    }
}
pub fn run_stdio() -> Result<(), ErrorCode> {
    run(io::stdin().lock(), io::stdout().lock())
}
