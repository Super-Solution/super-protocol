//! The shadow replay: `conformance/agent-loop-replay.v0.json`. Each scenario is a run described by what goes over the
//! wire (the bytes of every model call, what every tool does, what the person answers). The file also holds what Super
//! Chat's real `runAgent` did with them: the events, and the body of every request. Here the Rust driver and the Rust
//! OpenAI provider do the same run, and must produce the same events and byte-for-byte the same request bodies.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use super_agent_loop::{
    Driver, HttpResponse, OpenAiChat, Person, RunSpec, ToolCtx, ToolDef, ToolError, ToolReturn,
    ToolSpec, Tools, Transport, TransportError,
};

fn read(name: &str) -> Value {
    let path = format!("{}/../../conformance/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .unwrap()
}

// ---- the scripted outside world ---------------------------------------------------------------------------------------

/// A body that answers one scripted chunk per read, so the decoder sees exactly the cuts of the scenario.
struct Chunked {
    chunks: Vec<Vec<u8>>,
    at: usize,
    off: usize,
}

impl Read for Chunked {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let Some(c) = self.chunks.get(self.at) else {
            return Ok(0);
        };
        let n = (c.len() - self.off).min(buf.len());
        buf[..n].copy_from_slice(&c[self.off..self.off + n]);
        self.off += n;
        if self.off == c.len() {
            self.at += 1;
            self.off = 0;
        }
        Ok(n)
    }
}

fn chunk_bytes(c: &Value) -> Vec<u8> {
    match c {
        Value::String(s) => s.as_bytes().to_vec(),
        other => {
            // base64 without a dependency: the data uses it only for bytes that are not text on their own
            let b64 = other["b64"]
                .as_str()
                .expect("a chunk is a string or { b64 }");
            let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let (mut out, mut acc, mut bits) = (vec![], 0u32, 0);
            for ch in b64.bytes().filter(|b| *b != b'=') {
                acc = (acc << 6) | table.iter().position(|t| *t == ch).unwrap() as u32;
                bits += 6;
                if bits >= 8 {
                    bits -= 8;
                    out.push((acc >> bits) as u8);
                    acc &= (1 << bits) - 1;
                }
            }
            out
        }
    }
}

struct Scripted {
    calls: Vec<Value>,
    seen: Mutex<Vec<Value>>,
}

#[derive(Clone)]
struct Wire(Arc<Scripted>);

impl Transport for Wire {
    fn post_json(&self, path: &str, body: &Value) -> Result<HttpResponse, TransportError> {
        let mut seen = self.0.seen.lock().unwrap();
        let n = seen.len();
        seen.push(json!({"path": path, "body": body}));
        let Some(call) = self.0.calls.get(n) else {
            return Err(TransportError {
                kind: "unknown".into(),
                message: format!(
                    "the loop made model call {}, the scenario has {}",
                    n + 1,
                    self.0.calls.len()
                ),
            });
        };
        if let Some(status) = call["status"].as_u64() {
            let text = match call["text"].as_str() {
                Some(t) => t.to_string(),
                None => call["body"].to_string(),
            };
            return Ok(HttpResponse {
                status: status as u16,
                status_text: String::new(),
                body: Box::new(std::io::Cursor::new(text.into_bytes())),
            });
        }
        let chunks = call["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(chunk_bytes)
            .collect();
        Ok(HttpResponse {
            status: 200,
            status_text: "OK".into(),
            body: Box::new(Chunked {
                chunks,
                at: 0,
                off: 0,
            }),
        })
    }
}

struct ScriptedTools {
    scripts: HashMap<String, Vec<Value>>,
    used: Mutex<HashMap<String, usize>>,
}

impl Tools for ScriptedTools {
    fn execute(&self, name: &str, _input: &Value, _ctx: &ToolCtx) -> Result<ToolReturn, ToolError> {
        let script = &self.scripts[name];
        let i = {
            let mut used = self.used.lock().unwrap();
            let slot = used.entry(name.to_string()).or_insert(0);
            let i = *slot;
            *slot += 1;
            i
        };
        let step = &script[i.min(script.len() - 1)];
        if let Some(ms) = step["delayMs"].as_u64() {
            std::thread::sleep(Duration::from_millis(ms));
        }
        if step["failure"] == "execution-error" {
            return Err(ToolError {
                kind: None,
                message: step["error"].as_str().unwrap().to_string(),
            });
        }
        Ok(ToolReturn {
            output: step["output"].clone(),
            failure: step["failure"].as_str().map(str::to_string),
        })
    }
}

struct ScriptedPerson(HashMap<String, Value>);

impl Person for ScriptedPerson {
    fn answer(&self, card: &Value) -> Value {
        self.0
            .get(card["callId"].as_str().unwrap())
            .cloned()
            .expect("the scenario scripts an answer for every card")
    }
}

// ---- the run ----------------------------------------------------------------------------------------------------------

fn run(s: &Value) -> (Vec<Value>, Vec<Value>) {
    let wire = Wire(Arc::new(Scripted {
        calls: s["calls"].as_array().unwrap().clone(),
        seen: Mutex::new(vec![]),
    }));
    let model = OpenAiChat::new(wire.clone(), "test-model");
    let tools = ScriptedTools {
        scripts: s["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                (
                    t["name"].as_str().unwrap().to_string(),
                    t["script"].as_array().unwrap().clone(),
                )
            })
            .collect(),
        used: Mutex::new(HashMap::new()),
    };
    let person = ScriptedPerson(
        s["actions"]
            .as_object()
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default(),
    );
    let spec = RunSpec {
        run_id: "run_1".into(),
        system: s["system"].as_str().map(str::to_string),
        tools: s["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| ToolDef {
                spec: ToolSpec {
                    name: t["name"].as_str().unwrap().into(),
                    description: t["description"].as_str().unwrap().into(),
                    parameters: t["parameters"].clone(),
                    strict: false,
                },
                side: t["side"].as_str().unwrap().into(),
            })
            .collect(),
        max_steps: s["config"]["maxSteps"].as_u64(),
        stop_when: s["config"]["stopWhen"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        interactive: s["config"]["interactive"] == true,
        repeat_guard: false,
    };
    let driver = Driver {
        model: &model,
        tools: &tools,
        person: Some(&person),
        spec,
    };
    let out = driver
        .run(
            s["messages"].as_array().unwrap().clone(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let mut events = out.events;
    for e in &mut events {
        if e["type"] == "tool-result" {
            e["ms"] = json!(0); // how long a tool took on a real clock: only its presence is compared
        }
    }
    let seen = wire.0.seen.lock().unwrap().clone();
    (events, seen)
}

#[test]
fn every_scenario_in_agent_loop_replay_v0_json() {
    let file = read("agent-loop-replay.v0.json");
    assert_eq!(file["version"], "agent-loop-replay.v0");
    let scenarios = file["scenarios"].as_array().unwrap();
    assert!(
        scenarios.len() >= 25,
        "the file has {} scenarios",
        scenarios.len()
    );
    let mut failures = vec![];
    for s in scenarios {
        let name = s["name"].as_str().unwrap();
        let (events, requests) = run(s);
        let want = &s["expected"];
        if Value::Array(events.clone()) != want["events"] {
            failures.push(format!(
                "{name}: events differ\n  want {}\n  got  {}",
                want["events"],
                Value::Array(events)
            ));
        }
        if Value::Array(requests.clone()) != want["requests"] {
            failures.push(format!(
                "{name}: request bodies differ\n  want {}\n  got  {}",
                want["requests"],
                Value::Array(requests.clone())
            ));
        } else if serde_json::to_string(&requests).unwrap()
            != serde_json::to_string(&want["requests"]).unwrap()
        {
            // equal as values; unequal as bytes means the keys are in another order on the wire
            failures.push(format!("{name}: request bodies have another key order than JSON.stringify gives\n  want {}\n  got  {}", want["requests"], Value::Array(requests)));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} scenarios differ:\n{}",
        failures.len(),
        scenarios.len(),
        failures.join("\n")
    );
}
