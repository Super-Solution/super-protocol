//! The agent loop as a sans-IO state machine (spike). No clock, no ids, no network, no async.
//! It is fed inputs and answers with events and effects; see ../SPEC.md. Everything is `serde_json::Value`
//! on purpose: the conformance file is the contract, and typed wrappers are a later, separate decision.
//! Throwaway code, never published.

use serde_json::{json, Map, Value};

const USAGE_KEYS: [&str; 5] = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens"];

fn add_usage(a: &Value, b: &Value) -> Value {
    let mut out = Map::new();
    for k in USAGE_KEYS {
        let (x, y) = (a.get(k).and_then(Value::as_u64), b.get(k).and_then(Value::as_u64));
        if x.is_none() && y.is_none() {
            continue;
        }
        out.insert(k.to_string(), json!(x.unwrap_or(0) + y.unwrap_or(0)));
    }
    Value::Object(out)
}

fn usage_is_empty(u: &Value) -> bool {
    USAGE_KEYS.iter().all(|k| u.get(*k).and_then(Value::as_u64).is_none())
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Model,
    Tools,
    Ask,
    Done,
}

#[derive(Clone)]
struct Call {
    call_id: String,
    name: String,
    input: Value,
}

#[derive(Clone)]
struct Outcome {
    call_id: String,
    name: String,
    output: Value,
    failure: Option<String>,
    ms: Value,
}

pub struct Step {
    pub events: Vec<Value>,
    pub effects: Vec<Value>,
}

pub struct LoopMachine {
    config: Value,
    phase: Phase,
    run_id: String,
    step: u64,
    attempted: u64,
    usage: Value,
    finish_reason: String,
    step_finish: String,
    cancelled: bool,
    calls: Vec<Call>,
    outcomes: Vec<Outcome>,
    running: Vec<String>,
    confirm_queue: Vec<Call>,
    asking: Option<Call>,
    streaks: Vec<u64>,
    events: Vec<Value>,
    effects: Vec<Value>,
}

type R = Result<(), String>;

fn illegal(why: &str) -> R {
    Err(format!("illegal-input: {why}"))
}

impl LoopMachine {
    pub fn new(config: Value) -> Self {
        let n = config.get("stopWhen").and_then(Value::as_array).map_or(0, Vec::len);
        LoopMachine {
            config,
            phase: Phase::Idle,
            run_id: String::new(),
            step: 0,
            attempted: 0,
            usage: json!({}),
            finish_reason: "unknown".into(),
            step_finish: "unknown".into(),
            cancelled: false,
            calls: vec![],
            outcomes: vec![],
            running: vec![],
            confirm_queue: vec![],
            asking: None,
            streaks: vec![0; n],
            events: vec![],
            effects: vec![],
        }
    }

    fn max_steps(&self) -> u64 {
        self.config.get("maxSteps").and_then(Value::as_u64).unwrap_or(8)
    }

    fn tools(&self) -> Vec<(String, String)> {
        self.config["tools"]
            .as_array()
            .map(|a| a.iter().map(|t| (t["name"].as_str().unwrap().to_string(), t["side"].as_str().unwrap().to_string())).collect())
            .unwrap_or_default()
    }

    fn tool_names(&self) -> Vec<Value> {
        self.tools().into_iter().map(|(n, _)| json!(n)).collect()
    }

    fn side_of(&self, name: &str) -> Option<String> {
        self.tools().into_iter().find(|(n, _)| n == name).map(|(_, s)| s)
    }

    pub fn feed(&mut self, input: &Value) -> Result<Step, String> {
        self.events = vec![];
        self.effects = vec![];
        match input["kind"].as_str().unwrap_or("") {
            "start" => {
                if self.phase != Phase::Idle {
                    return Err("illegal-input: start twice".into());
                }
                self.run_id = input["runId"].as_str().unwrap_or("").to_string();
                let mode = input["mode"].clone();
                self.events.push(json!({"type": "run-start", "runId": self.run_id, "mode": mode}));
                self.loop_top();
            }
            "model-result" => {
                if self.phase != Phase::Model {
                    return Err("illegal-input: model-result with no model call outstanding".into());
                }
                self.on_model_result(input);
            }
            "model-error" => {
                if self.phase != Phase::Model {
                    return Err("illegal-input: model-error with no model call outstanding".into());
                }
                let usage = input.get("usage").cloned();
                self.fail(input["error"]["kind"].as_str().unwrap_or("unknown"), input["error"]["message"].as_str().unwrap_or(""), usage);
            }
            "tool-outcome" => {
                let id = input["callId"].as_str().unwrap_or("").to_string();
                let Some(pos) = self.running.iter().position(|r| *r == id) else {
                    return Err(format!("illegal-input: tool-outcome for {id}, which is not running"));
                };
                self.running.remove(pos);
                let name = self.calls.iter().find(|c| c.call_id == id).map(|c| c.name.clone()).unwrap_or_default();
                self.settle(Outcome {
                    call_id: id,
                    name,
                    output: input["output"].clone(),
                    failure: input["failure"].as_str().map(str::to_string),
                    ms: input["ms"].clone(),
                });
                self.advance();
            }
            "user-action" => {
                let id = input["callId"].as_str().unwrap_or("");
                if self.phase != Phase::Ask || self.asking.as_ref().map(|a| a.call_id.as_str()) != Some(id) {
                    return Err(format!("illegal-input: user-action for {id}, which is not asked"));
                }
                self.on_user_action(input);
            }
            "cancel" => {
                if matches!(self.phase, Phase::Idle | Phase::Done) {
                    return Err("illegal-input: cancel outside a run".into());
                }
                self.cancelled = true;
            }
            other => return illegal(&format!("unknown input kind {other}")).map(|_| unreachable!()),
        }
        Ok(Step { events: std::mem::take(&mut self.events), effects: std::mem::take(&mut self.effects) })
    }

    fn loop_top(&mut self) {
        if self.step >= self.max_steps() {
            return self.finish_run();
        }
        if self.cancelled {
            return self.fail("cancelled", "Run was cancelled.", None);
        }
        self.attempted += 1;
        self.events.push(json!({"type": "step-start", "step": self.step}));
        self.effects.push(json!({"kind": "call-model", "step": self.step, "toolNames": self.tool_names()}));
        self.phase = Phase::Model;
    }

    fn on_model_result(&mut self, input: &Value) {
        let parts = input["parts"].as_array().cloned().unwrap_or_default();
        let usage = input.get("usage").cloned().unwrap_or_else(|| json!({}));
        self.usage = add_usage(&self.usage, &usage);
        for p in &parts {
            if p["type"] == "text" {
                self.events.push(json!({"type": "text-delta", "delta": p["text"]}));
            }
        }
        self.events.push(json!({"type": "usage", "usage": usage}));
        self.events.push(json!({"type": "step-finish", "step": self.step, "finishReason": input["finishReason"], "usage": usage}));
        self.step_finish = input["finishReason"].as_str().unwrap_or("unknown").to_string();
        self.effects.push(json!({"kind": "append", "message": {"role": "assistant", "parts": parts}}));

        self.calls = parts
            .iter()
            .filter(|p| p["type"] == "tool-call")
            .map(|p| Call { call_id: p["callId"].as_str().unwrap_or("").into(), name: p["name"].as_str().unwrap_or("").into(), input: p["input"].clone() })
            .collect();
        if self.calls.is_empty() {
            self.finish_reason = self.step_finish.clone();
            return self.finish_run();
        }
        for c in self.calls.clone() {
            self.events.push(json!({"type": "tool-call", "callId": c.call_id, "name": c.name, "input": c.input}));
        }
        self.outcomes = vec![];
        self.running = vec![];
        self.confirm_queue = self.calls.iter().filter(|c| self.side_of(&c.name).as_deref() == Some("confirm")).cloned().collect();
        for c in self.calls.clone() {
            if self.confirm_queue.iter().any(|q| q.call_id == c.call_id) {
                continue;
            }
            if self.side_of(&c.name).is_none() {
                let output = json!({"error": format!("Unknown tool \"{}\".", c.name), "availableTools": self.tool_names()});
                self.settle(Outcome { call_id: c.call_id, name: c.name, output, failure: Some("not-found".into()), ms: json!(0) });
            } else {
                self.effects.push(json!({"kind": "run-tool", "callId": c.call_id, "name": c.name, "input": c.input}));
                self.running.push(c.call_id);
            }
        }
        self.phase = Phase::Tools;
        self.advance();
    }

    fn settle(&mut self, o: Outcome) {
        let mut ev = json!({"type": "tool-result", "callId": o.call_id, "name": o.name, "output": o.output, "ms": o.ms});
        if let Some(f) = &o.failure {
            ev["failure"] = json!(f);
        }
        self.events.push(ev);
        self.outcomes.push(o);
    }

    fn advance(&mut self) {
        if !self.running.is_empty() {
            return;
        }
        while !self.confirm_queue.is_empty() {
            let next = self.confirm_queue.remove(0);
            if self.config.get("interactive").and_then(Value::as_bool) != Some(true) {
                let output = json!({"error": format!("\"{}\" needs the user's approval and this host cannot ask for it.", next.name)});
                self.settle(Outcome { call_id: next.call_id, name: next.name, output, failure: Some("denied".into()), ms: json!(0) });
                continue;
            }
            self.events.push(json!({
                "type": "awaiting-user",
                "callId": next.call_id,
                "card": {"id": format!("approval:{}", next.call_id), "callId": next.call_id, "spec": {"kind": "confirm", "tool": next.name, "input": next.input}}
            }));
            self.effects.push(json!({"kind": "ask-user", "callId": next.call_id}));
            self.asking = Some(next);
            self.phase = Phase::Ask;
            return;
        }
        self.end_step();
    }

    fn on_user_action(&mut self, input: &Value) {
        let call_id = input["callId"].as_str().unwrap_or("").to_string();
        let action = input["action"].clone();
        let asked = self.asking.take().expect("checked by feed");
        self.events.push(json!({"type": "user-responded", "callId": call_id, "action": action}));
        let kind = action["type"].as_str().unwrap_or("");
        let declined = kind == "cancel" || kind == "dismiss";
        let approved = !declined && (action.get("value").is_none() || action["value"]["confirmed"] == json!(true));
        self.phase = Phase::Tools;
        if approved {
            self.effects.push(json!({"kind": "run-tool", "callId": call_id, "name": asked.name, "input": asked.input}));
            self.running.push(call_id);
            return;
        }
        self.settle(Outcome { call_id, name: asked.name, output: json!({"error": "The user declined."}), failure: Some("denied".into()), ms: json!(0) });
        self.advance();
    }

    fn end_step(&mut self) {
        let ordered: Vec<Outcome> = self.calls.iter().filter_map(|c| self.outcomes.iter().find(|o| o.call_id == c.call_id).cloned()).collect();
        let parts: Vec<Value> = ordered
            .iter()
            .map(|o| {
                let mut p = json!({"type": "tool-result", "callId": o.call_id, "name": o.name, "output": o.output});
                if let Some(f) = &o.failure {
                    p["failure"] = json!(f);
                }
                p
            })
            .collect();
        self.effects.push(json!({"kind": "append", "message": {"role": "tool", "parts": parts}}));
        self.step += 1;
        self.finish_reason = self.step_finish.clone();
        if self.should_stop(&ordered) {
            self.finish_reason = "stop".into();
            return self.finish_run();
        }
        self.loop_top();
    }

    fn should_stop(&mut self, outcomes: &[Outcome]) -> bool {
        let conditions = self.config.get("stopWhen").and_then(Value::as_array).cloned().unwrap_or_default();
        for (i, c) in conditions.iter().enumerate() {
            let hit = match c["kind"].as_str().unwrap_or("") {
                "stepCountIs" => self.step >= c["n"].as_u64().unwrap_or(0),
                "afterTool" => outcomes.iter().any(|o| c["names"].as_array().is_some_and(|ns| ns.iter().any(|n| n == o.name.as_str())) && o.failure.is_none()),
                "tokenBudgetExceeded" => {
                    let total = self.usage.get("totalTokens").and_then(Value::as_u64).unwrap_or_else(|| {
                        self.usage.get("inputTokens").and_then(Value::as_u64).unwrap_or(0) + self.usage.get("outputTokens").and_then(Value::as_u64).unwrap_or(0)
                    });
                    total >= c["maxTotal"].as_u64().unwrap_or(u64::MAX)
                }
                "consecutiveFailures" => {
                    let all_failed = !outcomes.is_empty() && outcomes.iter().all(|o| o.failure.is_some());
                    self.streaks[i] = if all_failed { self.streaks[i] + 1 } else { 0 };
                    self.streaks[i] >= c["n"].as_u64().unwrap_or(u64::MAX)
                }
                "userDeclined" => outcomes.iter().any(|o| o.output.get("cancelled") == Some(&json!(true))),
                _ => false,
            };
            if hit {
                return true;
            }
        }
        false
    }

    fn finish_run(&mut self) {
        if self.step >= self.max_steps() && self.finish_reason == "tool-calls" {
            self.events.push(json!({"type": "message", "parts": [{"type": "notice", "code": "step-limit", "steps": self.max_steps()}]}));
        }
        self.events.push(json!({"type": "run-finish", "runId": self.run_id, "finishReason": self.finish_reason, "usage": self.usage, "steps": self.attempted}));
        self.effects.push(json!({"kind": "done"}));
        self.phase = Phase::Done;
    }

    fn fail(&mut self, kind: &str, message: &str, usage: Option<Value>) {
        if let Some(u) = usage {
            if !usage_is_empty(&u) {
                self.usage = add_usage(&self.usage, &u);
                self.events.push(json!({"type": "usage", "usage": u}));
            }
        }
        self.events.push(json!({"type": "error", "error": {"kind": kind, "message": message}, "recoverable": false}));
        let reason = if kind == "cancelled" { "cancelled" } else { "error" };
        self.events.push(json!({"type": "run-finish", "runId": self.run_id, "finishReason": reason, "usage": self.usage, "steps": self.attempted}));
        self.effects.push(json!({"kind": "done"}));
        self.phase = Phase::Done;
    }
}
