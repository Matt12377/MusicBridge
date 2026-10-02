use musicbridge_rust_core::{
    ErrorCode, MAX_FRAME_BYTES, MAX_MODELS, MAX_REQUESTS, Sidecar, is_collection_model, run,
};
use serde_json::{Value, json};
use std::io::{BufReader, Cursor, Write};
use std::process::{Command, Stdio};

const EPOCH: &str = "11111111-1111-4111-8111-111111111111";
const DATASET: &str = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT: &str = "33333333-3333-4333-8333-333333333333";
fn id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn model(n: usize) -> Value {
    json!({"id": id(n), "brand": "索尼", "name": "测试带", "edition": "", "year": null,
        "format": "cassette", "tapeType": "II", "identification": "partial", "collectorPolicy": "preserve-sealed",
        "minimumSealedReserve": 1, "revision": 2, "lengths": [null, 60, 90],
        "counts": {"total": 7, "sealedBlank": 1, "openedBlank": 1, "legacyUsed": 1, "recorded": 1, "reserved": 1, "unavailable": 1, "unknown": 1},
        "photoCount": 1, "featuredPhoto": {"id": id(10_000 + n), "modelId": id(n), "physicalId": "MB-C-12345", "width": 1200, "height": 800, "source": "user-photo"}})
}
fn frame(sequence: usize, operation: &str, payload: Value) -> Value {
    json!({"protocolVersion": 1, "requestId": id(sequence), "epoch": EPOCH, "datasetId": DATASET,
        "snapshotId": SNAPSHOT, "sequence": sequence, "operation": operation, "payload": payload})
}
fn list(offset: usize, limit: usize) -> Value {
    json!({"request": {"version": 1, "id": "合成读取", "command": "collection.list", "payload": {"page": {"offset": offset, "limit": limit}}, "expectedDatasetId": DATASET,
        "performanceTrace": {"traceId": id(500), "requestId": id(501)}}})
}
fn handle(s: &mut Sidecar, f: Value) -> Value {
    s.handle(&serde_json::to_vec(&f).unwrap()).unwrap().value
}
fn ready(models: Value) -> Sidecar {
    let mut s = Sidecar::new();
    assert_eq!(
        handle(&mut s, frame(1, "prepare", json!({"models": models})))["ok"],
        true
    );
    assert_eq!(
        handle(&mut s, frame(2, "commitBoot", json!({})))["result"],
        Value::Null
    );
    s
}
fn error(v: &Value, code: &str) {
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], code);
    assert_eq!(v["error"].as_object().unwrap().len(), 2);
}

#[test]
fn preserves_complete_models_order_and_identity_across_pages() {
    let models: Vec<_> = (1..=150).rev().map(model).collect();
    let mut s = ready(json!(models));
    let first = handle(&mut s, frame(3, "dispatch", list(0, 100)));
    assert_eq!(first["result"]["items"], json!(&models[..100]));
    assert_eq!(first["result"]["total"], 150);
    assert_eq!(first["result"]["hasMore"], true);
    assert_eq!(first["requestId"], id(3));
    assert_eq!(first["snapshotId"], SNAPSHOT);
    let rest = handle(&mut s, frame(4, "dispatch", list(100, 100)));
    assert_eq!(rest["result"]["items"], json!(&models[100..]));
    assert_eq!(rest["result"]["hasMore"], false);
    let end = handle(&mut s, frame(5, "dispatch", list(1_000_000, 1)));
    assert_eq!(end["result"]["items"], json!([]));
    assert_eq!(end["result"]["hasMore"], false);
    assert_eq!(first.as_object().unwrap().len(), 9);
}
#[test]
fn preparation_commit_and_close_follow_lifecycle() {
    let mut s = Sidecar::new();
    error(
        &handle(&mut s, frame(1, "dispatch", list(0, 1))),
        "NOT_READY",
    );
    let p = handle(&mut s, frame(2, "prepare", json!({"models": []})));
    assert_eq!(
        p["result"],
        json!({"epoch": EPOCH, "datasetId": DATASET, "snapshotId": SNAPSHOT, "readOnly": true, "capabilities": ["collection.list"], "modelCount": 0})
    );
    error(
        &handle(&mut s, frame(3, "prepare", json!({"models": [model(1)]}))),
        "INVALID_REQUEST",
    );
    error(
        &handle(&mut s, frame(4, "dispatch", list(0, 1))),
        "NOT_READY",
    );
    assert_eq!(
        handle(&mut s, frame(5, "commitBoot", json!({})))["ok"],
        true
    );
    let close = s
        .handle(&serde_json::to_vec(&frame(6, "close", json!({}))).unwrap())
        .unwrap();
    assert!(close.exit && !close.failed);
    assert_eq!(close.value["result"], Value::Null);
    assert_eq!(s.handle(b"{}").err(), Some(ErrorCode::Closing));
}
#[test]
fn rejects_every_missing_and_unknown_model_field() {
    let valid = model(1);
    assert!(is_collection_model(&valid));
    for field in [
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
    ] {
        let mut bad = valid.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(!is_collection_model(&bad), "缺失字段 {field}");
    }
    let mut bad = valid;
    bad["unknown"] = json!(true);
    assert!(!is_collection_model(&bad));
}
#[test]
fn rejects_invalid_model_contract_fields_and_counts() {
    let cases = [
        ("brand", json!("\u{0}")),
        ("name", json!("😀".repeat(61))),
        ("year", json!(1899)),
        ("tapeType", json!("dat")),
        ("identification", json!("future")),
        ("collectorPolicy", json!("future")),
        ("minimumSealedReserve", json!(-1)),
        ("revision", json!(0)),
        ("lengths", json!([0])),
        ("lengths", json!([1.5])),
        ("photoCount", json!(25)),
    ];
    for (field, value) in cases {
        let mut bad = model(1);
        bad[field] = value;
        assert!(!is_collection_model(&bad), "无效字段 {field}");
    }
    for field in [
        "total",
        "sealedBlank",
        "openedBlank",
        "legacyUsed",
        "recorded",
        "reserved",
        "unavailable",
        "unknown",
    ] {
        let mut bad = model(1);
        bad["counts"].as_object_mut().unwrap().remove(field);
        assert!(!is_collection_model(&bad));
    }
    let mut bad = model(1);
    bad["counts"]["total"] = json!(8);
    assert!(!is_collection_model(&bad));
    let mut bad = model(1);
    bad["counts"]["extra"] = json!(0);
    assert!(!is_collection_model(&bad));
    let mut bad = model(1);
    bad["featuredPhoto"]["modelId"] = json!(id(2));
    assert!(!is_collection_model(&bad));
    let mut bad = model(1);
    bad["featuredPhoto"]["width"] = json!(1201);
    assert!(!is_collection_model(&bad));
    let mut bad = model(1);
    bad["featuredPhoto"]["physicalId"] = json!("MB-C-1234");
    assert!(!is_collection_model(&bad));
    let mut bad = model(1);
    bad["identification"] = json!("verified");
    assert!(!is_collection_model(&bad));
}
#[test]
fn supports_imported_empty_and_dat_descriptors() {
    let mut m = model(1);
    m["brand"] = json!("");
    m["name"] = json!("");
    m["format"] = json!("dat");
    m["tapeType"] = json!("dat");
    assert!(is_collection_model(&m));
    m["identification"] = json!("verified");
    assert!(!is_collection_model(&m));
    m["brand"] = json!("品牌");
    m["name"] = json!("型号");
    m["edition"] = json!("版次");
    assert!(is_collection_model(&m));
}
#[test]
fn rejects_duplicate_ids_and_capacity_without_binding_partial_snapshot() {
    let mut s = Sidecar::new();
    error(
        &handle(
            &mut s,
            frame(1, "prepare", json!({"models": [model(1), model(1)]})),
        ),
        "INVALID_REQUEST",
    );
    assert_eq!(
        handle(&mut s, frame(2, "prepare", json!({"models": []})))["ok"],
        true
    );
    let mut s = Sidecar::new();
    let reply = s
        .handle(
            &serde_json::to_vec(&frame(
                1,
                "prepare",
                json!({"models": (0..=MAX_MODELS).map(model).collect::<Vec<_>>()}),
            ))
            .unwrap(),
        )
        .unwrap();
    error(&reply.value, "CAPACITY_EXCEEDED");
    assert!(reply.exit && reply.failed);
}
#[test]
fn rejects_identity_mismatch_sequence_gap_and_reused_request_id() {
    for field in ["epoch", "datasetId", "snapshotId"] {
        let mut s = ready(json!([]));
        let mut f = frame(3, "dispatch", list(0, 1));
        f[field] = json!(id(100));
        let r = s.handle(&serde_json::to_vec(&f).unwrap()).unwrap();
        error(&r.value, "SCOPE_MISMATCH");
        assert!(r.exit && r.failed);
    }
    let mut s = ready(json!([]));
    assert_eq!(
        s.handle(&serde_json::to_vec(&frame(4, "close", json!({}))).unwrap())
            .err(),
        Some(ErrorCode::ProtocolError)
    );
    let mut s = ready(json!([]));
    let mut f = frame(3, "close", json!({}));
    f["requestId"] = json!(id(1));
    assert_eq!(
        s.handle(&serde_json::to_vec(&f).unwrap()).err(),
        Some(ErrorCode::ProtocolError)
    );
}
#[test]
fn rejects_noncanonical_envelopes_nested_duplicates_and_bad_json() {
    for field in [
        "protocolVersion",
        "requestId",
        "epoch",
        "datasetId",
        "snapshotId",
        "sequence",
        "operation",
        "payload",
    ] {
        let mut f = frame(1, "prepare", json!({"models": []}));
        f.as_object_mut().unwrap().remove(field);
        assert_eq!(
            Sidecar::new()
                .handle(&serde_json::to_vec(&f).unwrap())
                .err(),
            Some(ErrorCode::ProtocolError)
        );
    }
    for bytes in [
        b"{}".as_slice(),
        b"{\"a\":1,\"a\":2}",
        b"{\"x\":{\"a\":1,\"a\":2}}",
        b"[1]",
        b"null",
        b"\xff",
        b"{} {}",
        b"{\"a\":NaN}",
    ] {
        assert_eq!(
            Sidecar::new().handle(bytes).err(),
            Some(ErrorCode::ProtocolError)
        );
    }
    for value in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!(9_007_199_254_740_992u64),
    ] {
        let mut f = frame(1, "close", json!({}));
        f["sequence"] = value;
        assert_eq!(
            Sidecar::new()
                .handle(&serde_json::to_vec(&f).unwrap())
                .err(),
            Some(ErrorCode::ProtocolError)
        );
    }
}
#[test]
fn refuses_filters_other_commands_and_malformed_dispatch_fields() {
    let mut s = ready(json!([]));
    let mut n = 3;
    for (mut req, code) in [
        (list(0, 1), "UNSUPPORTED_FILTER"),
        (list(0, 1), "UNSUPPORTED_COMMAND"),
        (list(0, 1), "INVALID_REQUEST"),
        (list(0, 1), "SCOPE_MISMATCH"),
    ] {
        match code {
            "UNSUPPORTED_FILTER" => req["request"]["payload"]["filter"] = json!({"query": "磁带"}),
            "UNSUPPORTED_COMMAND" => req["request"]["command"] = json!("collection.receive"),
            "INVALID_REQUEST" => req["request"]["readContext"] = json!({"deadlineAtMs": 1}),
            _ => req["request"]["expectedDatasetId"] = json!(id(90)),
        }
        error(&handle(&mut s, frame(n, "dispatch", req)), code);
        n += 1;
    }
    for pointer in [
        "/request/extra",
        "/request/payload/extra",
        "/request/payload/page/extra",
        "/request/performanceTrace/extra",
    ] {
        let mut p = list(0, 1);
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        p.pointer_mut(parent).unwrap()[key] = json!(true);
        error(&handle(&mut s, frame(n, "dispatch", p)), "INVALID_REQUEST");
        n += 1;
    }
    for (key, value) in [
        ("offset", json!(-1)),
        ("offset", json!(1_000_001)),
        ("offset", json!(0.1)),
        ("limit", json!(0)),
        ("limit", json!(101)),
        ("limit", json!("1")),
    ] {
        let mut p = list(0, 1);
        p["request"]["payload"]["page"][key] = value;
        error(&handle(&mut s, frame(n, "dispatch", p)), "INVALID_REQUEST");
        n += 1;
    }
    let mut p = list(0, 1);
    p["request"]["payload"]["filter"] = json!({});
    assert_eq!(handle(&mut s, frame(n, "dispatch", p))["ok"], true);
}
#[test]
fn caps_frame_before_allocation_and_requires_complete_lf_frame() {
    let mut output = vec![];
    assert_eq!(
        run(Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1]), &mut output),
        Err(ErrorCode::CapacityExceeded)
    );
    assert!(output.is_empty());
    assert_eq!(
        run(Cursor::new(b"{}"), &mut output),
        Err(ErrorCode::ProtocolError)
    );
    assert_eq!(run(Cursor::new(b""), &mut output), Ok(()));
    assert_eq!(
        run(
            BufReader::with_capacity(1, Cursor::new(b"\xff\n")),
            &mut output
        ),
        Err(ErrorCode::ProtocolError)
    );
}
#[test]
fn final_sequence_is_reserved_for_close() {
    let mut s = ready(json!([]));
    for n in 3..MAX_REQUESTS {
        assert_eq!(handle(&mut s, frame(n, "dispatch", list(0, 1)))["ok"], true);
    }
    let reply = s
        .handle(&serde_json::to_vec(&frame(MAX_REQUESTS, "dispatch", list(0, 1))).unwrap())
        .unwrap();
    error(&reply.value, "CAPACITY_EXCEEDED");
    assert!(reply.exit && reply.failed);
    let mut s = ready(json!([]));
    for n in 3..MAX_REQUESTS {
        assert_eq!(
            handle(&mut s, frame(n, "commitBoot", json!({})))["ok"],
            true
        );
    }
    let reply = s
        .handle(&serde_json::to_vec(&frame(MAX_REQUESTS, "close", json!({}))).unwrap())
        .unwrap();
    assert!(reply.exit && !reply.failed);
}
#[test]
fn real_binary_emits_only_protocol_and_exits_naturally() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_musicbridge-rust-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for f in [
        frame(1, "prepare", json!({"models": [model(1)]})),
        frame(2, "commitBoot", json!({})),
        frame(3, "dispatch", list(0, 100)),
        frame(4, "close", json!({})),
    ] {
        writeln!(stdin, "{f}").unwrap();
    }
    // close ACK 后自行退出，不依赖父 stdin EOF。
    let output = child.wait_with_output().unwrap();
    drop(stdin);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[2]["result"]["items"], json!([model(1)]));
}
#[test]
fn real_binary_eof_and_corruption_have_distinct_exit_status() {
    for (input, success) in [
        (vec![], true),
        (b"{}".to_vec(), false),
        (b"\xff\n".to_vec(), false),
        ("{\"secret\":\"不得回显\"}\n".as_bytes().to_vec(), false),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_musicbridge-rust-core"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.success(), success);
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn permits_json_integer_notation_and_maximum_snapshot() {
    let mut f = frame(
        1,
        "prepare",
        json!({"models": (0..MAX_MODELS).map(model).collect::<Vec<_>>()}),
    );
    f["protocolVersion"] = json!(1.0);
    f["sequence"] = json!(1.0);
    let mut s = Sidecar::default();
    assert_eq!(handle(&mut s, f)["result"]["modelCount"], MAX_MODELS);
    handle(&mut s, frame(2, "commitBoot", json!({})));
    let mut p = list(1999, 100);
    p["request"]["version"] = json!(1.0);
    assert_eq!(
        handle(&mut s, frame(3, "dispatch", p))["result"]["items"],
        json!([model(1999)])
    );
}

#[test]
fn fatal_failures_revoke_snapshot_and_unit_payloads_are_strict() {
    let mut s = ready(json!([model(1)]));
    error(
        &handle(&mut s, frame(3, "commitBoot", json!({"extra": 1}))),
        "INVALID_REQUEST",
    );
    error(
        &handle(&mut s, frame(4, "close", json!({"extra": 1}))),
        "INVALID_REQUEST",
    );
    error(
        &handle(&mut s, frame(5, "unsupported", json!({}))),
        "UNSUPPORTED_OPERATION",
    );
    let mut f = frame(6, "dispatch", list(0, 1));
    f["datasetId"] = json!(id(700));
    let reply = s.handle(&serde_json::to_vec(&f).unwrap()).unwrap();
    assert!(reply.exit && reply.failed);
    assert_eq!(
        s.handle(&serde_json::to_vec(&frame(7, "dispatch", list(0, 1))).unwrap())
            .err(),
        Some(ErrorCode::Closing)
    );
}

#[test]
fn differentiates_invalid_filters_from_unsupported_valid_filters() {
    let mut s = ready(json!([]));
    let mut sequence = 3;
    for filter in [
        json!(null),
        json!({"unknown": 1}),
        json!({"query": 1}),
        json!({"brand": "\u{0}"}),
        json!({"decade": 1901}),
        json!({"decade": 2300}),
        json!({"stockState": "future"}),
    ] {
        let mut p = list(0, 1);
        p["request"]["payload"]["filter"] = filter;
        error(
            &handle(&mut s, frame(sequence, "dispatch", p)),
            "INVALID_REQUEST",
        );
        sequence += 1;
    }
    for filter in [
        json!({"query": ""}),
        json!({"brand": "品牌"}),
        json!({"decade": "unknown"}),
        json!({"decade": 1900}),
        json!({"stockState": "recorded"}),
    ] {
        let mut p = list(0, 1);
        p["request"]["payload"]["filter"] = filter;
        error(
            &handle(&mut s, frame(sequence, "dispatch", p)),
            "UNSUPPORTED_FILTER",
        );
        sequence += 1;
    }
}
