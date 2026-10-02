use musicbridge_rust_core::{
    ErrorCode, MAX_APPEND_FRAME_BYTES, MAX_APPEND_INPUT_BYTES, MAX_LARGE_SNAPSHOT_BYTES, Reply,
    SNAPSHOT_CHUNK_MODELS, Sidecar, run,
};
use serde_json::{Value, json};
use std::io::{Cursor, Write};
use std::process::{Command, Stdio};

const EPOCH: &str = "11111111-1111-4111-8111-111111111111";
const DATASET: &str = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT: &str = "33333333-3333-4333-8333-333333333333";
fn id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn model(n: usize) -> Value {
    json!({"id": id(n), "brand": if n.is_multiple_of(2) {"SONY"} else {"écho"},
        "name": "HF_% 中文", "edition": "版次", "year": if n.is_multiple_of(3) {Value::Null} else {json!(1992)},
        "format": "cassette", "tapeType": "II", "identification": "verified", "collectorPolicy": "normal",
        "minimumSealedReserve": 0, "revision": 1, "lengths": [null, 60],
        "counts": {"total": 1, "sealedBlank": 1, "openedBlank": 0, "legacyUsed": 0, "recorded": 0, "reserved": 0, "unavailable": 0, "unknown": 0}})
}
fn frame(version: u64, sequence: usize, operation: &str, payload: Value) -> Value {
    json!({"protocolVersion": version, "requestId": id(sequence), "epoch": EPOCH, "datasetId": DATASET,
        "snapshotId": SNAPSHOT, "sequence": sequence, "operation": operation, "payload": payload})
}
fn send(s: &mut Sidecar, sequence: usize, operation: &str, payload: Value) -> Reply {
    s.handle(&serde_json::to_vec(&frame(3, sequence, operation, payload)).unwrap())
        .unwrap()
}
fn prepare(count: usize) -> Sidecar {
    let mut s = Sidecar::new();
    let reply = send(&mut s, 1, "prepare", json!({"modelCount": count}));
    assert!(!reply.exit && !reply.failed);
    assert_eq!(
        reply.value["result"],
        json!({"epoch": EPOCH, "datasetId": DATASET, "snapshotId": SNAPSHOT,
        "readOnly": true, "capabilities": ["collection.list"], "modelCount": 0, "expectedModelCount": count})
    );
    s
}
fn upload(s: &mut Sidecar, models: &[Value]) -> usize {
    for (index, chunk) in models.chunks(SNAPSHOT_CHUNK_MODELS).enumerate() {
        let reply = send(
            s,
            index + 2,
            "appendSnapshot",
            json!({"chunkIndex": index, "models": chunk}),
        );
        assert!(!reply.exit && !reply.failed);
        assert_eq!(
            reply.value["result"],
            json!({"chunkIndex": index, "receivedModelCount": (index * 128 + chunk.len())})
        );
    }
    models.len().div_ceil(SNAPSHOT_CHUNK_MODELS) + 2
}
fn query(offset: usize, filter: Value, projection: Value) -> Value {
    json!({"request": {"version": 1, "id": "合成大库", "command": "collection.list", "expectedDatasetId": DATASET,
        "payload": {"page": {"offset": offset, "limit": 100}, "filter": filter}}, "filterProjection": projection})
}
fn fatal(s: &mut Sidecar, sequence: usize, operation: &str, payload: Value, code: &str) {
    let reply = send(s, sequence, operation, payload);
    assert_eq!(reply.value["error"]["code"], code);
    assert_eq!(reply.value["ok"], false);
    assert!(reply.exit && reply.failed);
    assert!(reply.value.get("result").is_none());
    assert_eq!(s.handle(b"{}").err(), Some(ErrorCode::Closing));
}
fn padded_append(sequence: usize, index: usize, size: usize) -> Vec<u8> {
    let chunk: Vec<_> = (index * 128..index * 128 + 128).map(model).collect();
    let mut bytes = serde_json::to_vec(&frame(
        3,
        sequence,
        "appendSnapshot",
        json!({"chunkIndex": index, "models": chunk}),
    ))
    .unwrap();
    assert!(bytes.len() <= size);
    bytes.resize(size, b' ');
    bytes
}
fn snapshot_at_byte_limit() -> Vec<Value> {
    let mut models: Vec<_> = (0..5000).map(model).collect();
    for model in &mut models {
        for field in ["brand", "name", "edition"] {
            model[field] = json!("x".repeat(120));
        }
        model["lengths"] = json!(vec![360; 100]);
    }
    let bytes = serde_json::to_vec(
        &json!({"epoch": EPOCH, "datasetId": DATASET, "snapshotId": SNAPSHOT, "models": models}),
    )
    .unwrap()
    .len();
    let mut remaining = MAX_LARGE_SNAPSHOT_BYTES - bytes;
    // 每个 ASCII 替换为三字节汉字增加两字节；é 处理奇数，DTO 长度保持合法。
    for model in &mut models {
        for field in ["brand", "name", "edition"] {
            let wide = (remaining / 2).min(120);
            remaining -= wide * 2;
            let accent = usize::from(remaining == 1 && wide < 120);
            remaining -= accent;
            model[field] = json!(format!(
                "{}{}{}",
                "界".repeat(wide),
                "é".repeat(accent),
                "x".repeat(120 - wide - accent)
            ));
        }
    }
    assert_eq!(remaining, 0);
    assert_eq!(
        serde_json::to_vec(
            &json!({"epoch": EPOCH, "datasetId": DATASET, "snapshotId": SNAPSHOT, "models": models})
        )
        .unwrap()
        .len(),
        MAX_LARGE_SNAPSHOT_BYTES
    );
    models
}

#[test]
fn five_thousand_models_survive_forty_chunks_and_fifty_pages_in_order() {
    let models: Vec<_> = (0..5000).rev().map(model).collect();
    let mut s = prepare(models.len());
    let commit = upload(&mut s, &models);
    assert_eq!(commit, 42);
    assert_eq!(
        send(&mut s, commit, "commitBoot", json!({})).value["result"],
        Value::Null
    );
    let mut collected = Vec::new();
    for page in 0..50 {
        let reply = send(
            &mut s,
            commit + page + 1,
            "dispatch",
            query(page * 100, json!({}), json!({})),
        );
        let result = &reply.value["result"];
        assert_eq!(result["total"], 5000);
        assert_eq!(result["hasMore"], page < 49);
        collected.extend(result["items"].as_array().unwrap().iter().cloned());
    }
    assert_eq!(collected, models);
}

#[test]
fn empty_manifest_commits_without_append_and_partial_close_clears_upload() {
    let mut empty = prepare(0);
    assert_eq!(
        send(&mut empty, 2, "commitBoot", json!({})).value["ok"],
        true
    );
    assert_eq!(
        send(&mut empty, 3, "dispatch", query(0, json!({}), json!({}))).value["result"]["total"],
        0
    );
    let mut s = prepare(129);
    send(
        &mut s,
        2,
        "appendSnapshot",
        json!({"chunkIndex": 0, "models": (0..128).map(model).collect::<Vec<_>>()}),
    );
    let close = send(&mut s, 3, "close", json!({}));
    assert!(close.exit && !close.failed);
    assert_eq!(close.value["result"], Value::Null);
    assert_eq!(s.handle(b"{}").err(), Some(ErrorCode::Closing));
}

#[test]
fn manifest_is_closed_bounded_and_safe_integer() {
    for (payload, code) in [
        (json!({"modelCount": 5001}), "CAPACITY_EXCEEDED"),
        (json!({"modelCount": -1}), "INVALID_REQUEST"),
        (json!({"modelCount": 1.5}), "INVALID_REQUEST"),
        (
            json!({"modelCount": 9_007_199_254_740_992u64}),
            "INVALID_REQUEST",
        ),
        (json!({"modelCount": "0"}), "INVALID_REQUEST"),
        (json!({"modelCount": 0, "extra": true}), "INVALID_REQUEST"),
        (json!({"models": []}), "INVALID_REQUEST"),
        (json!({}), "INVALID_REQUEST"),
    ] {
        fatal(&mut Sidecar::new(), 1, "prepare", payload, code);
    }
}

#[test]
fn rejects_missing_out_of_order_short_long_and_extra_chunks() {
    fatal(
        &mut prepare(129),
        2,
        "commitBoot",
        json!({}),
        "INVALID_REQUEST",
    );
    for payload in [
        json!({"chunkIndex": 1, "models": (0..128).map(model).collect::<Vec<_>>()}),
        json!({"chunkIndex": 0, "models": (0..127).map(model).collect::<Vec<_>>()}),
        json!({"chunkIndex": 0, "models": (0..129).map(model).collect::<Vec<_>>()}),
        json!({"chunkIndex": 0, "models": [], "extra": 1}),
        json!({"chunkIndex": 0.5, "models": []}),
        json!({"models": []}),
    ] {
        fatal(
            &mut prepare(129),
            2,
            "appendSnapshot",
            payload,
            "INVALID_REQUEST",
        );
    }
    for count in [0, 1, 129, 5000] {
        let mut s = prepare(count);
        let commit = upload(&mut s, &(0..count).map(model).collect::<Vec<_>>());
        fatal(
            &mut s,
            commit,
            "appendSnapshot",
            json!({"chunkIndex": count.div_ceil(128), "models": [model(6000)]}),
            "INVALID_REQUEST",
        );
    }
    let mut s = prepare(129);
    upload(&mut s, &(0..128).map(model).collect::<Vec<_>>());
    fatal(
        &mut s,
        3,
        "appendSnapshot",
        json!({"chunkIndex": 0, "models": [model(128)]}),
        "INVALID_REQUEST",
    );
}

#[test]
fn duplicate_ids_and_invalid_dto_are_fatal_within_and_across_chunks() {
    let mut duplicate: Vec<_> = (0..128).map(model).collect();
    duplicate[127] = duplicate[0].clone();
    fatal(
        &mut prepare(129),
        2,
        "appendSnapshot",
        json!({"chunkIndex": 0, "models": duplicate}),
        "INVALID_REQUEST",
    );
    let mut s = prepare(129);
    upload(&mut s, &(0..128).map(model).collect::<Vec<_>>());
    fatal(
        &mut s,
        3,
        "appendSnapshot",
        json!({"chunkIndex": 1, "models": [model(0)]}),
        "INVALID_REQUEST",
    );
    for field in ["counts", "id", "year", "brand"] {
        let mut bad = model(1);
        bad.as_object_mut().unwrap().remove(field);
        fatal(
            &mut prepare(1),
            2,
            "appendSnapshot",
            json!({"chunkIndex": 0, "models": [bad]}),
            "INVALID_REQUEST",
        );
    }
    let mut bad = model(1);
    bad["extra"] = json!(1);
    fatal(
        &mut prepare(1),
        2,
        "appendSnapshot",
        json!({"chunkIndex": 0, "models": [bad]}),
        "INVALID_REQUEST",
    );
}

#[test]
fn partial_dispatch_and_every_postcommit_upload_operation_fail_closed() {
    let mut s = prepare(129);
    upload(&mut s, &(0..128).map(model).collect::<Vec<_>>());
    fatal(
        &mut s,
        3,
        "dispatch",
        query(0, json!({}), json!({})),
        "NOT_READY",
    );
    for (operation, payload) in [
        ("prepare", json!({"modelCount": 0})),
        ("appendSnapshot", json!({"chunkIndex": 0, "models": []})),
        ("commitBoot", json!({})),
    ] {
        let mut s = prepare(0);
        send(&mut s, 2, "commitBoot", json!({}));
        fatal(&mut s, 3, operation, payload, "INVALID_REQUEST");
    }
    fatal(
        &mut Sidecar::new(),
        1,
        "appendSnapshot",
        json!({"chunkIndex": 0, "models": []}),
        "NOT_READY",
    );
    fatal(
        &mut Sidecar::new(),
        1,
        "unknown",
        json!({}),
        "UNSUPPORTED_OPERATION",
    );
}

#[test]
fn append_frame_budget_accepts_exact_limit_and_rejects_one_extra_byte() {
    for size in [MAX_APPEND_FRAME_BYTES, MAX_APPEND_FRAME_BYTES + 1] {
        let mut s = prepare(128);
        let reply = s.handle(&padded_append(2, 0, size)).unwrap();
        assert_eq!(reply.value["ok"], size == MAX_APPEND_FRAME_BYTES);
        assert_eq!(reply.exit, size > MAX_APPEND_FRAME_BYTES);
        if reply.exit {
            assert_eq!(reply.value["error"]["code"], "CAPACITY_EXCEEDED");
            assert_eq!(s.handle(b"{}").err(), Some(ErrorCode::Closing));
        }
    }
}

#[test]
fn aggregate_append_budget_counts_raw_whitespace_and_every_lf_exactly() {
    for extra in [0, 1] {
        let mut s = prepare(9 * 128);
        for index in 0..8 {
            assert_eq!(
                s.handle(&padded_append(index + 2, index, MAX_APPEND_FRAME_BYTES))
                    .unwrap()
                    .value["ok"],
                true
            );
        }
        let remaining = MAX_APPEND_INPUT_BYTES - 8 * (MAX_APPEND_FRAME_BYTES + 1);
        let reply = s
            .handle(&padded_append(10, 8, remaining - 1 + extra))
            .unwrap();
        assert_eq!(reply.value["ok"], extra == 0);
        assert_eq!(reply.exit, extra == 1);
        if extra == 1 {
            assert_eq!(reply.value["error"]["code"], "CAPACITY_EXCEEDED");
        } else {
            assert_eq!(send(&mut s, 11, "commitBoot", json!({})).value["ok"], true);
        }
    }
}

#[test]
fn full_snapshot_budget_includes_identity_and_rejects_before_commit() {
    let exact = snapshot_at_byte_limit();
    let mut s = prepare(5000);
    let commit = upload(&mut s, &exact);
    assert_eq!(
        send(&mut s, commit, "commitBoot", json!({})).value["ok"],
        true
    );
    for float_integer in [false, true] {
        let mut models = exact.clone();
        if float_integer {
            // JSON.stringify(1.0) 为 1；规范预算不惩罚合法的浮点整数字面量。
            models[4999]["revision"] = json!(1.0);
        } else {
            let name = models[4999]["name"].as_str().unwrap();
            assert!(name.ends_with('x'));
            models[4999]["name"] = json!(format!("{}é", &name[..name.len() - 1]));
        }
        let input_bytes: usize = models
            .chunks(128)
            .enumerate()
            .map(|(index, chunk)| {
                serde_json::to_vec(&frame(
                    3,
                    index + 2,
                    "appendSnapshot",
                    json!({"chunkIndex": index, "models": chunk}),
                ))
                .unwrap()
                .len()
                    + 1
            })
            .sum();
        assert!(
            input_bytes < MAX_APPEND_INPUT_BYTES,
            "完整预算检查不依赖输入累计预算失败"
        );
        let mut s = prepare(5000);
        for (index, chunk) in models.chunks(128).enumerate() {
            let reply = send(
                &mut s,
                index + 2,
                "appendSnapshot",
                json!({"chunkIndex": index, "models": chunk}),
            );
            if index == 39 && !float_integer {
                assert_eq!(reply.value["error"]["code"], "CAPACITY_EXCEEDED");
                assert!(reply.exit && reply.failed);
                assert_eq!(s.handle(b"{}").err(), Some(ErrorCode::Closing));
            } else {
                assert_eq!(reply.value["ok"], true);
            }
        }
        if float_integer {
            assert_eq!(send(&mut s, 42, "commitBoot", json!({})).value["ok"], true);
        }
    }
}

#[test]
fn v3_queries_equal_v2_for_filters_dto_order_and_unicode_asymmetry() {
    let models: Vec<_> = (0..257).rev().map(model).collect();
    let mut v2 = Sidecar::new();
    v2.handle(&serde_json::to_vec(&frame(2, 1, "prepare", json!({"models": models}))).unwrap())
        .unwrap();
    v2.handle(&serde_json::to_vec(&frame(2, 2, "commitBoot", json!({}))).unwrap())
        .unwrap();
    let mut v3 = prepare(models.len());
    let commit = upload(&mut v3, &models);
    send(&mut v3, commit, "commitBoot", json!({}));
    for (index, (filter, projection)) in [
        (json!({}), json!({})),
        (
            json!({"query": "_%", "brand": "ＳＯＮＹ", "decade": 1990, "stockState": "blank"}),
            json!({"query": "_%", "brand": "sony"}),
        ),
        (json!({"brand": "ÉCHO"}), json!({"brand": "écho"})),
        (
            json!({"query": "中文", "decade": "unknown"}),
            json!({"query": "中文"}),
        ),
        (json!({"query": "　"}), json!({})),
    ]
    .into_iter()
    .enumerate()
    {
        for (page, offset) in [0, 100, 500].into_iter().enumerate() {
            let sequence = index * 3 + page;
            let payload = query(offset, filter.clone(), projection.clone());
            let old = v2
                .handle(
                    &serde_json::to_vec(&frame(2, sequence + 3, "dispatch", payload.clone()))
                        .unwrap(),
                )
                .unwrap();
            let new = send(&mut v3, commit + sequence + 1, "dispatch", payload);
            assert_eq!(old.value["result"], new.value["result"]);
        }
    }
    for version in [1, 2] {
        let mut old = Sidecar::new();
        let reply = old
            .handle(
                &serde_json::to_vec(&frame(
                    version,
                    1,
                    "prepare",
                    json!({"models": (0..2001).map(model).collect::<Vec<_>>()}),
                ))
                .unwrap(),
            )
            .unwrap();
        assert_eq!(reply.value["error"]["code"], "CAPACITY_EXCEEDED");
        assert!(reply.exit && reply.failed);
    }
}

#[test]
fn v3_identity_protocol_sequence_and_nested_duplicates_revoke_partial_state() {
    for field in [
        "epoch",
        "datasetId",
        "snapshotId",
        "protocolVersion",
        "sequence",
        "requestId",
    ] {
        let mut s = prepare(129);
        upload(&mut s, &(0..128).map(model).collect::<Vec<_>>());
        let mut f = frame(
            3,
            3,
            "appendSnapshot",
            json!({"chunkIndex": 1, "models": [model(128)]}),
        );
        f[field] = match field {
            "protocolVersion" => json!(2),
            "sequence" => json!(4),
            "requestId" => json!(id(1)),
            _ => json!(id(999)),
        };
        let result = s.handle(&serde_json::to_vec(&f).unwrap());
        if ["epoch", "datasetId", "snapshotId"].contains(&field) {
            let reply = result.unwrap();
            assert_eq!(reply.value["error"]["code"], "SCOPE_MISMATCH");
            assert!(reply.exit && reply.failed);
        } else {
            assert_eq!(result.err(), Some(ErrorCode::ProtocolError));
        }
        assert_eq!(s.handle(b"{}").err(), Some(ErrorCode::Closing));
    }
    let mut s = prepare(1);
    let raw = serde_json::to_string(&frame(
        3,
        2,
        "appendSnapshot",
        json!({"chunkIndex": 0, "models": [model(0)]}),
    ))
    .unwrap();
    let duplicate = raw.replace("\"chunkIndex\":0", "\"chunkIndex\":0,\"chunkIndex\":0");
    assert_ne!(raw, duplicate);
    assert_eq!(
        s.handle(duplicate.as_bytes()).err(),
        Some(ErrorCode::ProtocolError)
    );
    assert_eq!(s.handle(b"{}").err(), Some(ErrorCode::Closing));
}

#[test]
fn v3_keeps_dataset_uuid_versions_one_through_eight() {
    for version in 1..=8 {
        let dataset = format!("22222222-2222-{version}222-8222-222222222222");
        let mut s = Sidecar::new();
        for (sequence, operation, mut payload) in [
            (1, "prepare", json!({"modelCount": 0})),
            (2, "commitBoot", json!({})),
            (3, "dispatch", query(0, json!({}), json!({}))),
            (4, "close", json!({})),
        ] {
            let mut f = frame(3, sequence, operation, payload.clone());
            f["datasetId"] = json!(dataset);
            if operation == "dispatch" {
                payload["request"]["expectedDatasetId"] = json!(dataset);
                f["payload"] = payload;
            }
            assert_eq!(
                s.handle(&serde_json::to_vec(&f).unwrap()).unwrap().value["ok"],
                true
            );
        }
    }
}

#[test]
fn partial_eof_fails_and_real_partial_close_exits_without_stdin_eof() {
    for count in [0, 129] {
        let input = format!("{}\n", frame(3, 1, "prepare", json!({"modelCount": count})));
        let mut output = Vec::new();
        assert_eq!(
            run(Cursor::new(input), &mut output),
            Err(ErrorCode::ProtocolError)
        );
        assert_eq!(String::from_utf8(output).unwrap().lines().count(), 1);
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_musicbridge-rust-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for f in [
        frame(3, 1, "prepare", json!({"modelCount": 129})),
        frame(
            3,
            2,
            "appendSnapshot",
            json!({"chunkIndex": 0, "models": (0..128).map(model).collect::<Vec<_>>()}),
        ),
        frame(3, 3, "close", json!({})),
    ] {
        writeln!(input, "{f}").unwrap();
    }
    let output = child.wait_with_output().unwrap();
    drop(input);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 3);
    assert_eq!(replies[2]["result"], Value::Null);
}

#[test]
fn real_v3_upload_failure_replies_and_exits_with_open_parent_stdin() {
    for (operation, payload) in [
        ("commitBoot", json!({})),
        (
            "appendSnapshot",
            json!({"chunkIndex": 0, "models": [model(128)]}),
        ),
        ("dispatch", query(0, json!({}), json!({}))),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_musicbridge-rust-core"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        for f in [
            frame(3, 1, "prepare", json!({"modelCount": 129})),
            frame(
                3,
                2,
                "appendSnapshot",
                json!({"chunkIndex": 0, "models": (0..128).map(model).collect::<Vec<_>>()}),
            ),
            frame(3, 3, operation, payload),
        ] {
            writeln!(input, "{f}").unwrap();
        }
        let output = child.wait_with_output().unwrap();
        drop(input);
        assert!(!output.status.success());
        assert!(output.stderr.is_empty());
        let replies: Vec<Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[2]["ok"], false);
        assert!(replies[2].get("result").is_none());
        assert_eq!(
            replies[2]["error"]["code"],
            if operation == "dispatch" {
                "NOT_READY"
            } else {
                "INVALID_REQUEST"
            }
        );
    }
}
