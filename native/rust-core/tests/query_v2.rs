use musicbridge_rust_core::{ErrorCode, Sidecar};
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

const EPOCH: &str = "11111111-1111-4111-8111-111111111111";
const DATASET: &str = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT: &str = "33333333-3333-4333-8333-333333333333";
fn id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn model(
    n: usize,
    brand: &str,
    name: &str,
    year: Value,
    identified: bool,
    stock: [u64; 5],
) -> Value {
    json!({"id": id(n), "brand": brand, "name": name, "edition": "版次", "year": year,
        "format": "cassette", "tapeType": "II", "identification": if identified {"verified"} else {"partial"},
        "collectorPolicy": "normal", "minimumSealedReserve": 0, "revision": 1, "lengths": [],
        "counts": {"total": stock.iter().sum::<u64>(), "sealedBlank": stock[0], "openedBlank": stock[1],
            "legacyUsed": stock[2], "recorded": stock[3], "reserved": 0, "unavailable": 0, "unknown": stock[4]}})
}
fn models() -> Vec<Value> {
    vec![
        model(8, "SONY", "HF_% Pro", json!(1998), true, [1, 0, 0, 0, 0]),
        model(7, "Sony", "HF_% Pro", json!(1992.0), true, [0, 1, 0, 0, 1]),
        model(6, "Sony", "HF_% Pro", json!(1989), true, [0, 0, 1, 0, 0]),
        model(5, "Sony", "HFabc Pro", Value::Null, false, [0, 0, 0, 1, 0]),
        model(4, "TDK", "HF_% Pro", Value::Null, true, [0, 0, 0, 0, 0]),
        model(3, "ÉCHO", "中文😀", json!(2200), true, [0, 0, 0, 0, 0]),
        model(2, "écho", "中文😀", json!(1900), true, [0, 0, 0, 0, 0]),
        model(1, "Sony", "HF  Pro", json!(2001), false, [0, 0, 0, 0, 0]),
    ]
}
fn frame(version: u64, sequence: usize, operation: &str, payload: Value) -> Value {
    json!({"protocolVersion": version, "requestId": id(sequence), "epoch": EPOCH, "datasetId": DATASET,
        "snapshotId": SNAPSHOT, "sequence": sequence, "operation": operation, "payload": payload})
}
fn dispatch(offset: usize, limit: usize, filter: Value, projection: Value) -> Value {
    json!({"request": {"version": 1, "id": "合成筛选", "command": "collection.list",
        "expectedDatasetId": DATASET, "payload": {"page": {"offset": offset, "limit": limit}, "filter": filter}},
        "filterProjection": projection})
}
fn handle(s: &mut Sidecar, f: Value) -> Value {
    s.handle(&serde_json::to_vec(&f).unwrap()).unwrap().value
}
fn ready(version: u64) -> Sidecar {
    let mut s = Sidecar::new();
    let response = handle(
        &mut s,
        frame(version, 1, "prepare", json!({"models": models()})),
    );
    assert_eq!(
        response["result"],
        json!({"epoch": EPOCH, "datasetId": DATASET, "snapshotId": SNAPSHOT,
        "readOnly": true, "capabilities": ["collection.list"], "modelCount": 8})
    );
    assert_eq!(response["result"].as_object().unwrap().len(), 6);
    assert_eq!(
        handle(&mut s, frame(version, 2, "commitBoot", json!({})))["ok"],
        true
    );
    s
}
fn result_ids(result: &Value) -> Vec<String> {
    result["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_owned())
        .collect()
}
fn error(v: &Value, code: &str) {
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], code);
    assert_eq!(v["error"].as_object().unwrap().len(), 2);
}

#[test]
fn combines_all_filters_before_offset_and_counts_all_matches() {
    let mut s = ready(2);
    let response = handle(
        &mut s,
        frame(
            2,
            3,
            "dispatch",
            dispatch(
                1,
                1,
                json!({"query": "  ＨＦ＿％  ", "brand": "ＳＯＮＹ", "decade": 1990, "stockState": "blank"}),
                json!({"query": "hf_%", "brand": "sony"}),
            ),
        ),
    );
    assert_eq!(response["protocolVersion"], 2);
    assert_eq!(
        response["result"],
        json!({"items": [models()[1]], "total": 2, "offset": 1, "limit": 1, "hasMore": false})
    );
    let response = handle(
        &mut s,
        frame(
            2,
            4,
            "dispatch",
            dispatch(
                0,
                1,
                json!({"query": "HF_%", "brand": "Sony", "decade": 1990, "stockState": "blank"}),
                json!({"query": "hf_%", "brand": "sony"}),
            ),
        ),
    );
    assert_eq!(response["result"]["hasMore"], true);
    assert_eq!(response["result"]["items"], json!([models()[0]]));
    let response = handle(
        &mut s,
        frame(
            2,
            5,
            "dispatch",
            dispatch(100, 1, json!({"brand": "Sony"}), json!({"brand": "sony"})),
        ),
    );
    assert_eq!(response["result"]["total"], 5);
    assert_eq!(response["result"]["items"], json!([]));
    assert_eq!(response["result"]["hasMore"], false);
}

#[test]
fn uses_literal_substrings_ascii_model_lower_and_supplied_unicode_projection() {
    let mut s = ready(2);
    for (sequence, filter, projection, ids) in [
        (
            3,
            json!({"query": "_%"}),
            json!({"query": "_%"}),
            vec![8, 7, 6, 4],
        ),
        (
            4,
            json!({"brand": "ÉCHO"}),
            json!({"brand": "écho"}),
            vec![2],
        ),
        (
            5,
            json!({"query": "ÉCHO"}),
            json!({"query": "écho"}),
            vec![2],
        ),
        (
            6,
            json!({"query": "中文😀"}),
            json!({"query": "中文😀"}),
            vec![3, 2],
        ),
        (
            7,
            json!({"query": "HF   Pro"}),
            json!({"query": "hf pro"}),
            vec![],
        ),
        (
            8,
            json!({"query": "SONY HF_%"}),
            json!({"query": "sony hf_%"}),
            vec![8, 7, 6],
        ),
        (
            9,
            json!({"query": "版次"}),
            json!({"query": "版次"}),
            vec![8, 7, 6, 5, 4, 3, 2, 1],
        ),
        (
            10,
            json!({"query": "　\u{feff}", "brand": "\u{a0}"}),
            json!({}),
            vec![8, 7, 6, 5, 4, 3, 2, 1],
        ),
    ] {
        let response = handle(
            &mut s,
            frame(
                2,
                sequence,
                "dispatch",
                dispatch(0, 100, filter, projection),
            ),
        );
        assert_eq!(
            result_ids(&response["result"]),
            ids.into_iter().map(id).collect::<Vec<_>>()
        );
    }
    let mut request = dispatch(0, 100, json!({}), json!({}));
    request["request"]["payload"]
        .as_object_mut()
        .unwrap()
        .remove("filter");
    assert_eq!(
        handle(&mut s, frame(2, 11, "dispatch", request))["result"]["items"],
        json!(models())
    );
}

#[test]
fn applies_unknown_decade_and_each_stock_predicate() {
    let mut s = ready(2);
    for (sequence, filter, ids) in [
        (3, json!({"decade": "unknown"}), vec![5, 4]),
        (4, json!({"decade": 1900}), vec![2]),
        (5, json!({"decade": 2200}), vec![3]),
        (
            6,
            json!({"stockState": "identified"}),
            vec![8, 7, 6, 4, 3, 2],
        ),
        (7, json!({"stockState": "needs-review"}), vec![7, 5, 1]),
        (8, json!({"stockState": "blank"}), vec![8, 7]),
        (9, json!({"stockState": "recorded"}), vec![6, 5]),
        (
            10,
            json!({"decade": "unknown", "stockState": "recorded"}),
            vec![5],
        ),
    ] {
        let response = handle(
            &mut s,
            frame(2, sequence, "dispatch", dispatch(0, 100, filter, json!({}))),
        );
        assert_eq!(response["result"]["total"], ids.len());
        assert_eq!(
            result_ids(&response["result"]),
            ids.into_iter().map(id).collect::<Vec<_>>()
        );
    }
}

#[test]
fn projection_is_required_closed_and_bound_to_nonblank_public_fields() {
    let mut s = ready(2);
    let mut missing = dispatch(0, 1, json!({}), json!({}));
    missing.as_object_mut().unwrap().remove("filterProjection");
    let mut payloads = vec![missing];
    for (filter, projection) in [
        (json!({}), json!(null)),
        (json!({}), json!([])),
        (json!({}), json!({"decade": 1990})),
        (json!({}), json!({"query": "sony"})),
        (json!({"query": " "}), json!({"query": ""})),
        (json!({"brand": "　"}), json!({"brand": ""})),
        (json!({"query": "Sony"}), json!({})),
        (json!({"brand": "Sony"}), json!({})),
        (json!({"query": "Sony"}), json!({"query": 1})),
        (json!({"brand": "Sony"}), json!({"brand": false})),
        (
            json!({"query": "Sony"}),
            json!({"query": "😀".repeat(2049)}),
        ),
        (json!({"brand": "Sony"}), json!({"brand": "x".repeat(8193)})),
    ] {
        payloads.push(dispatch(0, 1, filter, projection));
    }
    for (n, payload) in payloads.into_iter().enumerate() {
        error(
            &handle(&mut s, frame(2, n + 3, "dispatch", payload)),
            "INVALID_REQUEST",
        );
    }
    // 边界按 UTF-8 字节计；这里只验证投影预算，不在 Rust 重做 TS 归一化。
    let mut s = ready(2);
    for (n, projection) in [
        json!({"query": "😀".repeat(2048)}),
        json!({"query": "x".repeat(8192)}),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            handle(
                &mut s,
                frame(
                    2,
                    n + 3,
                    "dispatch",
                    dispatch(0, 1, json!({"query": "合成"}), projection)
                )
            )["ok"],
            true
        );
    }
}

#[test]
fn rejects_invalid_public_filters_before_using_projection() {
    let mut s = ready(2);
    for (n, filter) in [
        json!(null),
        json!({"extra": 1}),
        json!({"query": 1}),
        json!({"query": "😀".repeat(61)}),
        json!({"brand": "a".repeat(121)}),
        json!({"brand": "\u{0}"}),
        json!({"decade": 1890}),
        json!({"decade": 2210}),
        json!({"decade": 1991}),
        json!({"decade": "1990"}),
        json!({"decade": 1990.5}),
        json!({"stockState": "future"}),
    ]
    .into_iter()
    .enumerate()
    {
        error(
            &handle(
                &mut s,
                frame(2, n + 3, "dispatch", dispatch(0, 1, filter, json!({}))),
            ),
            "INVALID_REQUEST",
        );
    }
}

#[test]
fn v1_frame_shape_and_unfiltered_result_remain_unchanged() {
    let mut s = ready(1);
    let mut payload = dispatch(0, 1, json!({}), json!({}));
    payload.as_object_mut().unwrap().remove("filterProjection");
    assert_eq!(
        handle(&mut s, frame(1, 3, "dispatch", payload.clone()))["result"],
        json!({"items": [models()[0]], "total": 8, "offset": 0, "limit": 1, "hasMore": true})
    );
    payload["request"]["payload"]["filter"] = json!({"query": ""});
    error(
        &handle(&mut s, frame(1, 4, "dispatch", payload)),
        "UNSUPPORTED_FILTER",
    );
    error(
        &handle(
            &mut s,
            frame(1, 5, "dispatch", dispatch(0, 1, json!({}), json!({}))),
        ),
        "INVALID_REQUEST",
    );
}

#[test]
fn prepared_version_cannot_change_in_any_later_frame() {
    for (version, next) in [(1, 2), (2, 1)] {
        for operation in ["prepare", "commitBoot", "dispatch", "close"] {
            let mut s = ready(version);
            let payload = match operation {
                "prepare" => json!({"models": []}),
                "dispatch" => dispatch(0, 1, json!({}), json!({})),
                _ => json!({}),
            };
            assert_eq!(
                s.handle(&serde_json::to_vec(&frame(next, 3, operation, payload)).unwrap())
                    .err(),
                Some(ErrorCode::ProtocolError)
            );
            assert_eq!(s.handle(b"{}").err(), Some(ErrorCode::Closing));
        }
    }
    // 失败的 prepare 没有绑定版本；成功 prepare 才绑定。
    let mut s = Sidecar::new();
    error(
        &handle(&mut s, frame(1, 1, "prepare", json!({"models": [{}]}))),
        "INVALID_REQUEST",
    );
    assert_eq!(
        handle(&mut s, frame(2, 2, "prepare", json!({"models": []})))["ok"],
        true
    );
    assert_eq!(
        handle(&mut s, frame(2, 3, "commitBoot", json!({})))["ok"],
        true
    );
}

#[test]
fn rejects_projection_duplicate_keys_and_unsupported_versions() {
    let mut s = ready(2);
    let raw = serde_json::to_string(&frame(
        2,
        3,
        "dispatch",
        dispatch(0, 1, json!({"query": "Sony"}), json!({"query": "sony"})),
    ))
    .unwrap();
    let duplicate = raw.replace(
        "\"filterProjection\":{\"query\":\"sony\"}",
        "\"filterProjection\":{\"query\":\"sony\",\"query\":\"tdk\"}",
    );
    assert_ne!(duplicate, raw);
    assert_eq!(
        s.handle(duplicate.as_bytes()).err(),
        Some(ErrorCode::ProtocolError)
    );
    for version in [0, 4] {
        assert_eq!(
            Sidecar::new()
                .handle(
                    &serde_json::to_vec(&frame(version, 1, "prepare", json!({"models": []})))
                        .unwrap()
                )
                .err(),
            Some(ErrorCode::ProtocolError)
        );
    }
}

#[test]
fn real_v2_binary_filters_and_closes_without_stdin_eof() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_musicbridge-rust-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for f in [
        frame(2, 1, "prepare", json!({"models": models()})),
        frame(2, 2, "commitBoot", json!({})),
        frame(
            2,
            3,
            "dispatch",
            dispatch(
                0,
                100,
                json!({"query": "_%", "stockState": "blank"}),
                json!({"query": "_%"}),
            ),
        ),
        frame(2, 4, "close", json!({})),
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
    assert_eq!(replies.len(), 4);
    assert_eq!(result_ids(&replies[2]["result"]), vec![id(8), id(7)]);
    assert_eq!(replies[3]["result"], Value::Null);
    assert!(replies.iter().all(|r| r["protocolVersion"] == 2));
}

#[test]
fn v2_preserves_existing_dataset_uuid_versions_but_v1_stays_v4() {
    for version in 1..=8 {
        let dataset = format!("22222222-2222-{version}222-8222-222222222222");
        let mut s = Sidecar::new();
        for (sequence, operation, mut payload) in [
            (1, "prepare", json!({"models": models()})),
            (2, "commitBoot", json!({})),
            (3, "dispatch", dispatch(0, 1, json!({}), json!({}))),
            (4, "close", json!({})),
        ] {
            if operation == "dispatch" {
                payload["request"]["expectedDatasetId"] = json!(dataset);
            }
            let mut f = frame(2, sequence, operation, payload);
            f["datasetId"] = json!(dataset);
            let result = handle(&mut s, f);
            assert_eq!(result["ok"], true);
            assert_eq!(result["datasetId"], dataset);
        }
        if version != 4 {
            let mut old = Sidecar::new();
            let mut f = frame(1, 1, "prepare", json!({"models": []}));
            f["datasetId"] = json!(dataset);
            assert_eq!(
                old.handle(&serde_json::to_vec(&f).unwrap()).err(),
                Some(ErrorCode::ProtocolError)
            );
        }
    }
}
