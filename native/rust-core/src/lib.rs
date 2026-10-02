//! 仅持有调用方提供的公开收藏快照，支持 v1 分页、v2 筛选与 v3 分块，不访问文件、网络或设备。
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fmt;
use std::io::{self, BufRead, Write};

pub const MAX_FRAME_BYTES: usize = 4_194_304;
pub const MAX_MODELS: usize = 2_000;
pub const MAX_LARGE_MODELS: usize = 5_000;
pub const SNAPSHOT_CHUNK_MODELS: usize = 128;
pub const MAX_SNAPSHOT_CHUNKS: usize = 40;
pub const MAX_APPEND_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_LARGE_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_APPEND_INPUT_BYTES: usize = MAX_LARGE_SNAPSHOT_BYTES + 64 * 1024;
pub const MAX_REQUESTS: usize = 65_536;
const MAX_PROJECTION_BYTES: usize = 8_192;
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

// DTO 的数值均是有界非负整数；按 JSON.stringify 的规范整数编码计算完整快照预算。
fn canonical_bytes(value: &Value) -> Result<usize, ErrorCode> {
    fn normalize(value: &mut Value) {
        match value {
            Value::Number(n) => {
                if let Some(integer) = n.as_f64().filter(|n| n.fract() == 0.0) {
                    *value = Value::from(integer as u64);
                }
            }
            Value::Array(values) => values.iter_mut().for_each(normalize),
            Value::Object(values) => values.values_mut().for_each(normalize),
            _ => {}
        }
    }
    let mut normalized = value.clone();
    normalize(&mut normalized);
    serde_json::to_vec(&normalized)
        .map(|bytes| bytes.len())
        .map_err(|_| ErrorCode::ProtocolError)
}

pub struct Sidecar {
    identity: Option<(Value, Value, Value)>,
    protocol_version: Option<u64>,
    models: Vec<Value>,
    expected_model_count: Option<usize>,
    next_chunk_index: usize,
    append_input_bytes: usize,
    snapshot_bytes: usize,
    model_ids: HashSet<String>,
    next_sequence: u64,
    requests: HashSet<String>,
    ready: bool,
    closed: bool,
}
impl Default for Sidecar {
    fn default() -> Self {
        Self {
            identity: None,
            protocol_version: None,
            models: Vec::new(),
            expected_model_count: None,
            next_chunk_index: 0,
            append_input_bytes: 0,
            snapshot_bytes: 0,
            model_ids: HashSet::new(),
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
            self.model_ids.clear();
            self.expected_model_count = None;
            self.next_chunk_index = 0;
            self.append_input_bytes = 0;
            self.snapshot_bytes = 0;
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
        let protocol_version = integer(&v["protocolVersion"], 1, 3);
        if !keys(&v, &envelope)
            || v.as_object().is_none_or(|o| o.len() != envelope.len())
            || protocol_version.is_none()
            || !["requestId", "epoch", "snapshotId"]
                .iter()
                .all(|k| uuid(&v[k], true, false))
            || !uuid(&v["datasetId"], protocol_version == Some(1), false)
            || integer(&v["sequence"], 1, MAX_SAFE_INTEGER).is_none()
            || !text(&v["operation"], false, 64)
            || !v["payload"].is_object()
        {
            return Err(ErrorCode::ProtocolError);
        }
        let protocol_version = protocol_version.unwrap();
        if self
            .protocol_version
            .is_some_and(|bound| bound != protocol_version)
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
                if protocol_version == 3 {
                    self.prepare_manifest(&v)
                } else if self.identity.is_some()
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
                        self.protocol_version = Some(protocol_version);
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
            "appendSnapshot" if protocol_version == 3 => self.append_snapshot(payload, frame.len()),
            "commitBoot" => {
                if !keys(payload, &[]) {
                    Err(ErrorCode::InvalidRequest)
                } else if self.identity.is_none() {
                    Err(ErrorCode::NotReady)
                } else if protocol_version == 3
                    && (self.ready || self.expected_model_count != Some(self.models.len()))
                {
                    Err(ErrorCode::InvalidRequest)
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
        // v3 启动失败必须退出并由 handle 清理部分事实；已提交查询沿用 v2 的非 fatal 回执。
        let exit = self.closed
            || (protocol_version == 3
                && result.is_err()
                && (!self.ready
                    || matches!(
                        v["operation"].as_str(),
                        Some("prepare" | "appendSnapshot" | "commitBoot")
                    )));
        Ok(self.reply(&v, result, exit))
    }
    fn prepare_manifest(&mut self, v: &Value) -> Result<Value, ErrorCode> {
        let payload = &v["payload"];
        if self.identity.is_some() || !keys(payload, &["modelCount"]) {
            return Err(ErrorCode::InvalidRequest);
        }
        let count = integer(&payload["modelCount"], 0, MAX_SAFE_INTEGER)
            .ok_or(ErrorCode::InvalidRequest)?;
        if count > MAX_LARGE_MODELS as u64 {
            return Err(ErrorCode::CapacityExceeded);
        }
        self.snapshot_bytes = canonical_bytes(&json!({
            "epoch": v["epoch"], "datasetId": v["datasetId"],
            "snapshotId": v["snapshotId"], "models": []
        }))?;
        self.expected_model_count = Some(count as usize);
        self.protocol_version = Some(3);
        self.identity = Some((
            v["epoch"].clone(),
            v["datasetId"].clone(),
            v["snapshotId"].clone(),
        ));
        Ok(
            json!({"epoch": v["epoch"], "datasetId": v["datasetId"], "snapshotId": v["snapshotId"],
            "readOnly": true, "capabilities": ["collection.list"], "modelCount": 0, "expectedModelCount": count}),
        )
    }
    fn append_snapshot(&mut self, payload: &Value, frame_bytes: usize) -> Result<Value, ErrorCode> {
        if self.ready || !keys(payload, &["chunkIndex", "models"]) {
            return Err(ErrorCode::InvalidRequest);
        }
        let expected = self.expected_model_count.ok_or(ErrorCode::NotReady)?;
        let chunk_index = integer(&payload["chunkIndex"], 0, MAX_SAFE_INTEGER)
            .ok_or(ErrorCode::InvalidRequest)?;
        let models = payload["models"]
            .as_array()
            .ok_or(ErrorCode::InvalidRequest)?;
        if chunk_index != self.next_chunk_index as u64
            || self.next_chunk_index >= MAX_SNAPSHOT_CHUNKS
            || self.models.len() == expected
            || models.len() != SNAPSHOT_CHUNK_MODELS.min(expected - self.models.len())
        {
            return Err(ErrorCode::InvalidRequest);
        }
        let input_bytes = self.append_input_bytes + frame_bytes + 1;
        if frame_bytes > MAX_APPEND_FRAME_BYTES || input_bytes > MAX_APPEND_INPUT_BYTES {
            return Err(ErrorCode::CapacityExceeded);
        }
        let mut snapshot_bytes = self.snapshot_bytes;
        for (i, model) in models.iter().enumerate() {
            if !is_collection_model(model)
                || !self
                    .model_ids
                    .insert(model["id"].as_str().unwrap().to_owned())
            {
                return Err(ErrorCode::InvalidRequest);
            }
            snapshot_bytes += canonical_bytes(model)? + usize::from(self.models.len() + i > 0);
            if snapshot_bytes > MAX_LARGE_SNAPSHOT_BYTES {
                return Err(ErrorCode::CapacityExceeded);
            }
        }
        self.models.extend_from_slice(models);
        self.snapshot_bytes = snapshot_bytes;
        self.append_input_bytes = input_bytes;
        self.next_chunk_index += 1;
        Ok(json!({"chunkIndex": chunk_index, "receivedModelCount": self.models.len()}))
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
        let filtered = matches!(self.protocol_version, Some(2 | 3));
        if !keys(
            payload,
            if filtered {
                &["request", "filterProjection"]
            } else {
                &["request"]
            },
        ) {
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
            if !filtered && !filter.as_object().unwrap().is_empty() {
                return Err(ErrorCode::UnsupportedFilter);
            }
        }
        let filter = p.get("filter");
        let projection = if filtered {
            let projection = &payload["filterProjection"];
            if !keys(projection, &["query", "brand"])
                || ["query", "brand"].iter().any(|key| {
                    let required = filter.and_then(|f| f.get(*key)).is_some_and(|v| {
                        !v.as_str().unwrap().trim_matches(js_whitespace).is_empty()
                    });
                    let supplied = projection.get(*key);
                    required != supplied.is_some()
                        || supplied.is_some_and(|v| {
                            v.as_str().is_none_or(|s| s.len() > MAX_PROJECTION_BYTES)
                        })
                })
            {
                return Err(ErrorCode::InvalidRequest);
            }
            Some(projection)
        } else {
            None
        };
        // 按 Node 导出的 rowid DESC 次序筛选；完整命中数与分页都来自同一不可变快照。
        let matches: Vec<&Value> = self
            .models
            .iter()
            .filter(|model| {
                projection.is_none_or(|projection| matches_filter(model, filter, projection))
            })
            .collect();
        let items: Vec<&Value> = matches.iter().skip(offset).take(limit).copied().collect();
        Ok(
            json!({"items": items, "offset": offset, "limit": limit, "total": matches.len(), "hasMore": offset + items.len() < matches.len()}),
        )
    }
}

fn matches_filter(model: &Value, filter: Option<&Value>, projection: &Value) -> bool {
    // TS 负责投影的 NFKC/trim/空白合并/Unicode lower；原始型号与 SQLite lower 一致仅折叠 ASCII。
    if projection.get("brand").is_some_and(|brand| {
        model["brand"].as_str().unwrap().to_ascii_lowercase() != brand.as_str().unwrap()
    }) || projection.get("query").is_some_and(|query| {
        let searchable = format!(
            "{} {} {}",
            model["brand"].as_str().unwrap(),
            model["name"].as_str().unwrap(),
            model["edition"].as_str().unwrap()
        )
        .to_ascii_lowercase();
        !searchable.contains(query.as_str().unwrap())
    }) {
        return false;
    }
    let Some(filter) = filter else {
        return true;
    };
    if let Some(decade) = filter.get("decade") {
        if decade == "unknown" {
            if !model["year"].is_null() {
                return false;
            }
        } else {
            let decade = integer(decade, 1900, 2200).unwrap();
            if integer(&model["year"], 1900, 2200)
                .is_none_or(|year| year < decade || year > decade + 9)
            {
                return false;
            }
        }
    }
    let count = |key: &str| integer(&model["counts"][key], 0, 1_000_000).unwrap();
    match filter.get("stockState").and_then(Value::as_str) {
        Some("identified") => model["identification"] == "verified",
        Some("needs-review") => model["identification"] != "verified" || count("unknown") > 0,
        Some("blank") => count("sealedBlank") + count("openedBlank") > 0,
        Some("recorded") => count("legacyUsed") + count("recorded") > 0,
        _ => true,
    }
}

pub fn run<R: BufRead, W: Write>(mut input: R, mut output: W) -> Result<(), ErrorCode> {
    let mut sidecar = Sidecar::new();
    let mut frame = Vec::new();
    loop {
        // fill_buf/consume 在追加前检查上限，避免 read_until 为超大帧无限分配。
        let chunk = input.fill_buf().map_err(|_| ErrorCode::ProtocolError)?;
        if chunk.is_empty() {
            return if frame.is_empty()
                && !(sidecar.protocol_version == Some(3) && !sidecar.ready && !sidecar.closed)
            {
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
