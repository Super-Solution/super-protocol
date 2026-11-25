//! This crate against the shared conformance data of Super Protocol: `conformance/agent-loop.v0.json` (the loop)
//! and `conformance/tool-repair.v0.json` (argument repair). Both are read from the repository, never copied.

use serde_json::Value;
use super_agent_loop::{normalize_tool_name, repair_tool_arguments, LoopMachine};

fn read(name: &str) -> Value {
    let path = format!("{}/../../conformance/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .unwrap()
}

/// What a case needs that this crate has. A case that needs more is skipped and named.
const FEATURES: [&str; 2] = ["repeat-guard", "checkpoint"];

#[test]
fn every_case_in_agent_loop_v0_json() {
    let file = read("agent-loop.v0.json");
    assert_eq!(file["version"], "agent-loop.v0");
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() >= 30, "the file has {} cases", cases.len());
    let mut failures = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if let Some(req) = case.get("requires").and_then(Value::as_array) {
            assert!(
                req.iter().all(|r| FEATURES.contains(&r.as_str().unwrap())),
                "{name} needs a feature this crate does not know"
            );
        }
        let mut m = LoopMachine::new(&case["config"]);
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            if step.get("fresh") == Some(&Value::Bool(true)) {
                m = LoopMachine::new(&case["config"]);
            }
            let got = m.feed(&step["in"]);
            if step.get("reject") == Some(&Value::Bool(true)) {
                match got {
                    Err(e) if e.to_string().starts_with("illegal-input") => {}
                    other => failures.push(format!(
                        "{name} step {i}: should have been refused, got {other:?}"
                    )),
                }
                continue;
            }
            match got {
                Err(e) => failures.push(format!("{name} step {i}: {e}")),
                Ok(s) => {
                    if Value::Array(s.events.clone()) != step["events"] {
                        failures.push(format!(
                            "{name} step {i}: events differ\n got {}\nwant {}",
                            Value::Array(s.events),
                            step["events"]
                        ));
                    } else if Value::Array(s.effects.clone()) != step["effects"] {
                        failures.push(format!(
                            "{name} step {i}: effects differ\n got {}\nwant {}",
                            Value::Array(s.effects),
                            step["effects"]
                        ));
                    }
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// Same JSON value: object key order does not matter and numbers compare by value.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

#[test]
fn every_case_in_tool_repair_v0_json() {
    let file = read("tool-repair.v0.json");
    let cases = file["repair"].as_array().unwrap();
    assert!(
        cases.len() >= 700,
        "the file has {} repair cases",
        cases.len()
    );
    let mut failures = vec![];
    for c in cases {
        let got = repair_tool_arguments(&c["input"]).to_value();
        if !same(&got, &c["expect"]) {
            let shown = c["input"].to_string();
            failures.push(format!(
                "input {}\n got {got}\nwant {}",
                &shown[..shown.len().min(160)],
                c["expect"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} repair cases failed; first:\n{}",
        failures.len(),
        cases.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );

    for c in file["normalize_name"].as_array().unwrap() {
        assert_eq!(
            Value::String(normalize_tool_name(c["input"].as_str().unwrap())),
            c["expect"],
            "name {}",
            c["input"]
        );
    }
}
