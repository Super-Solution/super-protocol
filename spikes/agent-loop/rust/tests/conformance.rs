use agent_loop_spike::LoopMachine;
use serde_json::Value;

#[test]
fn every_case_in_agent_loop_v0_json() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../cases/agent-loop.v0.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut failures = vec![];
    let cases = file["cases"].as_array().unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut m = LoopMachine::new(case["config"].clone());
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let got = m.feed(&step["in"]);
            if step.get("reject") == Some(&Value::Bool(true)) {
                match got {
                    Err(e) if e.starts_with("illegal-input") => {}
                    _ => failures.push(format!("{name} step {i}: should have been refused")),
                }
                continue;
            }
            match got {
                Err(e) => failures.push(format!("{name} step {i}: {e}")),
                Ok(s) => {
                    if Value::Array(s.events.clone()) != step["events"] {
                        failures.push(format!("{name} step {i}: events differ\n got {}\nwant {}", Value::Array(s.events), step["events"]));
                    } else if Value::Array(s.effects.clone()) != step["effects"] {
                        failures.push(format!("{name} step {i}: effects differ\n got {}\nwant {}", Value::Array(s.effects), step["effects"]));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} cases failed:\n{}", failures.len(), cases.len(), failures.join("\n"));
}
