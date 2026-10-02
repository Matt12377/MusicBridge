use musicbridge_rust_core::{ErrorCode, Reply, SNAPSHOT_CHUNK_MODELS, Sidecar};
use serde_json::{Value, json};

const EPOCH: &str = "11111111-1111-4111-8111-111111111111";
const DATASET: &str = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT: &str = "33333333-3333-4333-8333-333333333333";

fn id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn frame(version: u64, sequence: usize, operation: &str, payload: Value) -> Value {
    json!({"protocolVersion": version, "requestId": id(sequence), "epoch": EPOCH,
        "datasetId": DATASET, "snapshotId": SNAPSHOT, "sequence": sequence,
        "operation": operation, "payload": payload})
}
fn send(sidecar: &mut Sidecar, version: u64, sequence: usize, op: &str, payload: Value) -> Reply {
    sidecar
        .handle(&serde_json::to_vec(&frame(version, sequence, op, payload)).unwrap())
        .unwrap()
}
fn model(n: usize) -> Value {
    let brand = ["SONY", "Sony", "TDK", "ÉCHO", "écho", "ＳＯＮＹ", "中文😀"][n % 7];
    let name = ["HF_%", "HF  Pro", "HFabc", "中文😀", "ｈｆ＿％"][n % 5];
    let years = [
        json!(1900),
        json!(1909),
        json!(1990),
        json!(1999),
        json!(2000),
        json!(2200),
        Value::Null,
    ];
    let counts = [
        u64::from(n.is_multiple_of(2)),
        u64::from(n.is_multiple_of(3)),
        u64::from(n.is_multiple_of(5)),
        u64::from(n.is_multiple_of(7)),
        u64::from(n.is_multiple_of(11)),
        u64::from(n.is_multiple_of(13)),
        u64::from(n.is_multiple_of(17)),
    ];
    let mut result = json!({"id": id(n + 100_000), "brand": brand, "name": name,
        "edition": "版次_%", "year": years[n % 7], "format": "cassette", "tapeType": "II",
        "identification": if n.is_multiple_of(4) {"partial"} else {"verified"},
        "collectorPolicy": "collector", "minimumSealedReserve": 2, "revision": 17,
        "lengths": [null, 46, 90], "photoCount": 3,
        "counts": {"total": counts.iter().sum::<u64>(), "sealedBlank": counts[0],
            "openedBlank": counts[1], "legacyUsed": counts[2], "recorded": counts[3],
            "reserved": counts[4], "unavailable": counts[5], "unknown": counts[6]}});
    if n.is_multiple_of(3) {
        result["featuredPhoto"] = json!({"id": id(n + 200_000), "modelId": result["id"],
            "physicalId": "MB-C-00001", "width": 1200, "height": 800, "source": "user-photo"});
    }
    result
}
fn ready(version: u64, models: &[Value]) -> (Sidecar, usize) {
    let mut sidecar = Sidecar::new();
    let prepare = if version == 3 {
        json!({"modelCount": models.len()})
    } else {
        json!({"models": models})
    };
    assert_eq!(
        send(&mut sidecar, version, 1, "prepare", prepare).value["ok"],
        true
    );
    let mut sequence = 2;
    if version == 3 {
        for (chunk_index, chunk) in models.chunks(SNAPSHOT_CHUNK_MODELS).enumerate() {
            assert_eq!(
                send(
                    &mut sidecar,
                    3,
                    sequence,
                    "appendSnapshot",
                    json!({"chunkIndex": chunk_index, "models": chunk})
                )
                .value["ok"],
                true
            );
            sequence += 1;
        }
    }
    assert_eq!(
        send(&mut sidecar, version, sequence, "commitBoot", json!({})).value["ok"],
        true
    );
    (sidecar, sequence + 1)
}
fn query(offset: usize, limit: usize, filter: &Value, projection: &Value) -> Value {
    json!({"request": {"version": 1, "id": "索引差分", "command": "collection.list",
        "expectedDatasetId": DATASET, "payload": {"page": {"offset": offset, "limit": limit},
        "filter": filter}}, "filterProjection": projection})
}

// 独立保留 RUST-004 的逐 DTO 线性谓词作为 oracle，不使用索引或衍生字段。
fn linear_reference(
    models: &[Value],
    filter: &Value,
    projection: &Value,
    offset: usize,
    limit: usize,
) -> Value {
    let matching: Vec<_> = models
        .iter()
        .filter(|model| {
            if projection.get("brand").is_some_and(|brand| {
                model["brand"].as_str().unwrap().to_ascii_lowercase() != brand.as_str().unwrap()
            }) || projection.get("query").is_some_and(|query| {
                !format!(
                    "{} {} {}",
                    model["brand"].as_str().unwrap(),
                    model["name"].as_str().unwrap(),
                    model["edition"].as_str().unwrap()
                )
                .to_ascii_lowercase()
                .contains(query.as_str().unwrap())
            }) {
                return false;
            }
            if let Some(decade) = filter.get("decade") {
                if decade == "unknown" {
                    if !model["year"].is_null() {
                        return false;
                    }
                } else {
                    let start = decade.as_u64().unwrap();
                    if model["year"]
                        .as_u64()
                        .is_none_or(|year| !(start..=start + 9).contains(&year))
                    {
                        return false;
                    }
                }
            }
            let count = |key: &str| model["counts"][key].as_u64().unwrap();
            match filter.get("stockState").and_then(Value::as_str) {
                Some("identified") => model["identification"] == "verified",
                Some("needs-review") => {
                    model["identification"] != "verified" || count("unknown") > 0
                }
                Some("blank") => count("sealedBlank") + count("openedBlank") > 0,
                Some("recorded") => count("legacyUsed") + count("recorded") > 0,
                _ => true,
            }
        })
        .collect();
    let items: Vec<_> = matching.iter().skip(offset).take(limit).copied().collect();
    json!({"items": items, "offset": offset, "limit": limit, "total": matching.len(),
        "hasMore": offset + items.len() < matching.len()})
}

#[test]
fn indexed_queries_equal_old_linear_contract_across_sizes_and_candidate_selectivities() {
    for (version, size) in [(2, 0), (2, 100), (2, 2000), (3, 5000)] {
        // 非 ID 排序，确保结果严格保持导出 ordinal。
        let models: Vec<_> = (0..size).rev().map(model).collect();
        let (mut sidecar, mut sequence) = ready(version, &models);
        let text_cases = [
            (json!({}), json!({})),
            (json!({"query": "_%"}), json!({"query": "_%"})),
            (json!({"brand": "ＳＯＮＹ"}), json!({"brand": "sony"})),
            (
                json!({"brand": "ÉCHO", "query": "中文😀"}),
                json!({"brand": "écho", "query": "中文😀"}),
            ),
            (json!({"query": "HF   Pro"}), json!({"query": "hf pro"})),
            (
                json!({"brand": "不存在", "query": "HF_%"}),
                json!({"brand": "不存在", "query": "hf_%"}),
            ),
            (json!({"query": "　\u{feff}", "brand": "\u{a0}"}), json!({})),
        ];
        for (text_filter, projection) in text_cases {
            for decade in [
                None,
                Some(json!(1900)),
                Some(json!(1990)),
                Some(json!(2200)),
                Some(json!("unknown")),
            ] {
                for stock in [
                    None,
                    Some("identified"),
                    Some("needs-review"),
                    Some("blank"),
                    Some("recorded"),
                ] {
                    let mut filter = text_filter.clone();
                    if let Some(decade) = &decade {
                        filter["decade"] = decade.clone();
                    }
                    if let Some(stock) = stock {
                        filter["stockState"] = json!(stock);
                    }
                    for (offset, limit) in [(0, 1), (1, 7), (99, 100), (1_000_000, 100)] {
                        let actual = send(
                            &mut sidecar,
                            version,
                            sequence,
                            "dispatch",
                            query(offset, limit, &filter, &projection),
                        );
                        assert_eq!(actual.value["ok"], true);
                        assert_eq!(
                            actual.value["result"],
                            linear_reference(&models, &filter, &projection, offset, limit),
                            "版本={version}, 规模={size}, 筛选={filter}, offset={offset}, limit={limit}"
                        );
                        sequence += 1;
                    }
                }
            }
        }
    }
}

#[test]
fn overlapping_inventory_unknown_year_and_full_dto_survive_repeated_boot() {
    let mut overlapping = model(1);
    overlapping["year"] = Value::Null;
    overlapping["counts"] = json!({"total": 7, "sealedBlank": 1, "openedBlank": 1,
        "legacyUsed": 1, "recorded": 1, "reserved": 1, "unavailable": 1, "unknown": 1});
    overlapping["featuredPhoto"] = json!({"id": id(999_999), "modelId": overlapping["id"],
        "width": 1, "height": 1200, "source": "user-photo"});
    let models = vec![model(2), overlapping.clone(), model(3)];
    let (mut sidecar, mut sequence) = ready(2, &models);
    for state in ["identified", "needs-review", "blank", "recorded"] {
        // v2 重复 boot 是已有合法路径，仍须返回同代完整事实。
        assert_eq!(
            send(&mut sidecar, 2, sequence, "commitBoot", json!({})).value["ok"],
            true
        );
        sequence += 1;
        let actual = send(
            &mut sidecar,
            2,
            sequence,
            "dispatch",
            query(
                0,
                100,
                &json!({"decade": "unknown", "stockState": state}),
                &json!({}),
            ),
        );
        assert_eq!(
            actual.value["result"],
            json!({"items": [overlapping], "offset": 0, "limit": 100, "total": 1, "hasMore": false})
        );
        sequence += 1;
    }
    let close = send(&mut sidecar, 2, sequence, "close", json!({}));
    assert!(close.exit && !close.failed);
    assert_eq!(sidecar.handle(b"{}").err(), Some(ErrorCode::Closing));
    let fresh = vec![model(27)];
    let (mut new_sidecar, sequence) = ready(2, &fresh);
    assert_eq!(
        send(
            &mut new_sidecar,
            2,
            sequence,
            "dispatch",
            query(0, 100, &json!({}), &json!({}))
        )
        .value["result"]["items"],
        json!(fresh)
    );
}

#[test]
fn incomplete_upload_cannot_publish_queries_and_fatal_boot_revokes_partial_facts() {
    let mut sidecar = Sidecar::new();
    send(&mut sidecar, 3, 1, "prepare", json!({"modelCount": 129}));
    send(
        &mut sidecar,
        3,
        2,
        "appendSnapshot",
        json!({"chunkIndex": 0, "models": (0..128).map(model).collect::<Vec<_>>()}),
    );
    let rejected = send(&mut sidecar, 3, 3, "commitBoot", json!({}));
    assert!(rejected.exit && rejected.failed);
    assert_eq!(rejected.value["error"]["code"], "INVALID_REQUEST");
    assert_eq!(sidecar.handle(b"{}").err(), Some(ErrorCode::Closing));

    let mut not_ready = Sidecar::new();
    send(
        &mut not_ready,
        2,
        1,
        "prepare",
        json!({"models": [model(1)]}),
    );
    let rejected = send(
        &mut not_ready,
        2,
        2,
        "dispatch",
        query(0, 1, &json!({}), &json!({})),
    );
    assert_eq!(rejected.value["error"]["code"], "NOT_READY");
    assert!(!rejected.exit);
    assert_eq!(
        send(&mut not_ready, 2, 3, "commitBoot", json!({})).value["ok"],
        true
    );
    assert_eq!(
        send(
            &mut not_ready,
            2,
            4,
            "dispatch",
            query(0, 1, &json!({}), &json!({}))
        )
        .value["result"]["items"],
        json!([model(1)])
    );
}
