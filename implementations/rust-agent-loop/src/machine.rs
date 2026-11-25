use serde_json::{json, Map, Value};
use std::fmt;

/// The version of the checkpoint format. A machine refuses a state it does not know.
pub const CHECKPOINT_VERSION: u64 = 0;

/// The words the model reads when the person declines. `userDeclined` recognises them.
pub const USER_DECLINED: &str = "The user declined.";

const USAGE_KEYS: [&str; 5] = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
];

/// An input that answers nothing the machine asked for. A bug in the driver, never something to guess around.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IllegalInput(pub String);

impl fmt::Display for IllegalInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "illegal-input: {}", self.0)
    }
}

impl std::error::Error for IllegalInput {}

fn illegal<T>(why: impl Into<String>) -> Result<T, IllegalInput> {
    Err(IllegalInput(why.into()))
}

/// What one input produced: the events to report and the effects for the driver, in order.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub events: Vec<Value>,
    pub effects: Vec<Value>,
}

fn add_usage(a: &Value, b: &Value) -> Value {
    let mut out = Map::new();
    for k in USAGE_KEYS {
        let (x, y) = (
            a.get(k).and_then(Value::as_u64),
            b.get(k).and_then(Value::as_u64),
        );
        if x.is_none() && y.is_none() {
            continue;
        }
        out.insert(k.to_string(), json!(x.unwrap_or(0) + y.unwrap_or(0)));
    }
    Value::Object(out)
}

fn usage_is_empty(u: &Value) -> bool {
    USAGE_KEYS
        .iter()
        .all(|k| u.get(*k).and_then(Value::as_u64).is_none())
}

/// Two JSON values are the same when they have the same shape and the same content; object key order does not
/// matter and numbers compare by value (`1` and `1.0` are the same).
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y || x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

/// Whether an outcome is the person saying no: a runtime approval declined, a tool that asks for itself returning
/// `{ cancelled: true }`, or a declined interactive card (`{ response: { cancelled: true } }`).
pub fn is_user_decline(output: &Value, failure: Option<&str>) -> bool {
    let Some(o) = output.as_object() else {
        return false;
    };
    if failure == Some("denied") && o.get("error").and_then(Value::as_str) == Some(USER_DECLINED) {
        return true;
    }
    if o.get("cancelled") == Some(&Value::Bool(true)) {
        return true;
    }
    o.get("response")
        .and_then(Value::as_object)
        .is_some_and(|r| r.get("cancelled") == Some(&Value::Bool(true)))
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Idle,
    Model,
    Tools,
    Ask,
    Done,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Model => "model",
            Phase::Tools => "tools",
            Phase::Ask => "ask",
            Phase::Done => "done",
        }
    }
}

#[derive(Clone, Debug)]
struct Call {
    call_id: String,
    name: String,
    input: Value,
}

impl Call {
    fn from_value(v: &Value) -> Call {
        Call {
            call_id: v["callId"].as_str().unwrap_or("").into(),
            name: v["name"].as_str().unwrap_or("").into(),
            input: v["input"].clone(),
        }
    }

    fn to_value(&self) -> Value {
        json!({"callId": self.call_id, "name": self.name, "input": self.input})
    }
}

#[derive(Clone, Debug)]
struct Outcome {
    call_id: String,
    name: String,
    output: Value,
    failure: Option<String>,
    ms: Value,
}

impl Outcome {
    fn from_value(v: &Value) -> Outcome {
        Outcome {
            call_id: v["callId"].as_str().unwrap_or("").into(),
            name: v["name"].as_str().unwrap_or("").into(),
            output: v["output"].clone(),
            failure: v["failure"].as_str().map(str::to_string),
            ms: v["ms"].clone(),
        }
    }

    /// The shape used in a checkpoint (with `ms`).
    fn to_value(&self) -> Value {
        let mut o = json!({"callId": self.call_id, "name": self.name, "output": self.output, "ms": self.ms});
        if let Some(f) = &self.failure {
            o["failure"] = json!(f);
        }
        o
    }

    /// The shape used in the tool message written to history (no `ms`).
    fn to_part(&self) -> Value {
        let mut p = json!({"type": "tool-result", "callId": self.call_id, "name": self.name, "output": self.output});
        if let Some(f) = &self.failure {
            p["failure"] = json!(f);
        }
        p
    }
}

struct Tool {
    name: String,
    side: String,
}

/// The agent loop's decisions. Feed it inputs; it answers with events and effects.
pub struct LoopMachine {
    max_steps: u64,
    stop_when: Vec<Value>,
    interactive: bool,
    repeat_guard: bool,
    tools: Vec<Tool>,

    phase: Phase,
    run_id: String,
    mode: Value,
    step: u64,
    attempted: u64,
    usage: Value,
    finish_reason: String,
    step_finish: String,
    cancelled: bool,
    calls: Vec<Call>,
    settled: Vec<Outcome>,
    running: Vec<String>,
    confirm_queue: Vec<Call>,
    asking: Option<Call>,
    streaks: Vec<u64>,
    seen: Vec<(String, Value)>,
    events: Vec<Value>,
    effects: Vec<Value>,
}

impl LoopMachine {
    /// `config` is the case config of the conformance file: `maxSteps?`, `stopWhen?`, `interactive?`,
    /// `repeatGuard?`, and `tools: [{ name, side }]`.
    pub fn new(config: &Value) -> Self {
        let stop_when = config
            .get("stopWhen")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        LoopMachine {
            max_steps: config.get("maxSteps").and_then(Value::as_u64).unwrap_or(8),
            streaks: vec![0; stop_when.len()],
            stop_when,
            interactive: config.get("interactive").and_then(Value::as_bool) == Some(true),
            repeat_guard: config.get("repeatGuard").and_then(Value::as_bool) == Some(true),
            tools: config["tools"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|t| Tool {
                            name: t["name"].as_str().unwrap_or("").into(),
                            side: t["side"].as_str().unwrap_or("").into(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            phase: Phase::Idle,
            run_id: String::new(),
            mode: json!("stream"),
            step: 0,
            attempted: 0,
            usage: json!({}),
            finish_reason: "unknown".into(),
            step_finish: "unknown".into(),
            cancelled: false,
            calls: vec![],
            settled: vec![],
            running: vec![],
            confirm_queue: vec![],
            asking: None,
            seen: vec![],
            events: vec![],
            effects: vec![],
        }
    }

    fn tool_names(&self) -> Vec<Value> {
        self.tools.iter().map(|t| json!(t.name)).collect()
    }

    fn side_of(&self, name: &str) -> Option<&str> {
        self.tools
            .iter()
            .find(|t| t.name == name)
            .map(|t| t.side.as_str())
    }

    fn outcome_of(&self, call_id: &str) -> Option<&Outcome> {
        self.settled.iter().find(|o| o.call_id == call_id)
    }

    /// Give the machine one input. An input it cannot accept is refused with `IllegalInput` and changes nothing.
    pub fn feed(&mut self, input: &Value) -> Result<Step, IllegalInput> {
        self.events = vec![];
        self.effects = vec![];
        match input["kind"].as_str().unwrap_or("") {
            "start" => {
                if self.phase != Phase::Idle {
                    return illegal("start twice");
                }
                self.run_id = input["runId"].as_str().unwrap_or("").to_string();
                self.mode = input["mode"].clone();
                self.events
                    .push(json!({"type": "run-start", "runId": self.run_id, "mode": self.mode}));
                self.loop_top();
            }
            "model-result" => {
                if self.phase != Phase::Model {
                    return illegal("model-result with no model call outstanding");
                }
                self.on_model_result(input);
            }
            "model-error" => {
                if self.phase != Phase::Model {
                    return illegal("model-error with no model call outstanding");
                }
                let usage = input.get("usage").cloned();
                self.fail(
                    input["error"]["kind"].as_str().unwrap_or("unknown"),
                    input["error"]["message"].as_str().unwrap_or(""),
                    usage,
                );
            }
            "tool-outcome" => {
                let id = input["callId"].as_str().unwrap_or("").to_string();
                let Some(pos) = self.running.iter().position(|r| *r == id) else {
                    return illegal(format!("tool-outcome for {id}, which is not running"));
                };
                self.running.remove(pos);
                let name = self
                    .calls
                    .iter()
                    .find(|c| c.call_id == id)
                    .map(|c| c.name.clone())
                    .unwrap_or_default();
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
                if self.phase != Phase::Ask
                    || self.asking.as_ref().map(|a| a.call_id.as_str()) != Some(id)
                {
                    return illegal(format!("user-action for {id}, which is not asked"));
                }
                self.on_user_action(input);
            }
            "cancel" => {
                if matches!(self.phase, Phase::Idle | Phase::Done) {
                    return illegal("cancel outside a run");
                }
                self.cancelled = true;
            }
            "snapshot" => {
                if !matches!(self.phase, Phase::Model | Phase::Tools | Phase::Ask) {
                    return illegal("snapshot with nothing in flight");
                }
                let state = self.checkpoint();
                self.effects
                    .push(json!({"kind": "checkpoint", "state": state}));
            }
            "resume" => {
                if self.phase != Phase::Idle {
                    return illegal("resume on a machine that has started");
                }
                self.restore(&input["state"])?;
            }
            other => return illegal(format!("unknown input kind {other}")),
        }
        Ok(Step {
            events: std::mem::take(&mut self.events),
            effects: std::mem::take(&mut self.effects),
        })
    }

    /// `while (step < maxSteps)`: the cancel check comes before step-start, and only inside the loop.
    fn loop_top(&mut self) {
        if self.step >= self.max_steps {
            return self.finish_run();
        }
        if self.cancelled {
            return self.fail("cancelled", "Run was cancelled.", None);
        }
        self.attempted += 1;
        self.events
            .push(json!({"type": "step-start", "step": self.step}));
        self.effects
            .push(json!({"kind": "call-model", "step": self.step, "toolNames": self.tool_names()}));
        self.phase = Phase::Model;
    }

    fn on_model_result(&mut self, input: &Value) {
        let parts = input["parts"].as_array().cloned().unwrap_or_default();
        let usage = input.get("usage").cloned().unwrap_or_else(|| json!({}));
        self.usage = add_usage(&self.usage, &usage);
        for p in &parts {
            if p["type"] == "text" {
                self.events
                    .push(json!({"type": "text-delta", "delta": p["text"]}));
            }
        }
        self.events.push(json!({"type": "usage", "usage": usage}));
        self.events.push(json!({"type": "step-finish", "step": self.step, "finishReason": input["finishReason"], "usage": usage}));
        self.step_finish = input["finishReason"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        self.effects
            .push(json!({"kind": "append", "message": {"role": "assistant", "parts": parts}}));

        let call_parts: Vec<&Value> = parts.iter().filter(|p| p["type"] == "tool-call").collect();
        self.calls = call_parts.iter().map(|p| Call::from_value(p)).collect();
        if self.calls.is_empty() {
            self.finish_reason = self.step_finish.clone();
            return self.finish_run();
        }
        for p in call_parts {
            let mut ev = json!({"type": "tool-call", "callId": p["callId"], "name": p["name"], "input": p["input"]});
            if p["repaired"] == json!(true) {
                ev["repaired"] = json!(true);
            }
            self.events.push(ev);
        }

        self.settled = vec![];
        self.running = vec![];
        self.confirm_queue = vec![];
        for c in self.calls.clone() {
            let Some(side) = self.side_of(&c.name).map(str::to_string) else {
                let output = json!({"error": format!("Unknown tool \"{}\".", c.name), "availableTools": self.tool_names()});
                self.settle(Outcome {
                    call_id: c.call_id,
                    name: c.name,
                    output,
                    failure: Some("not-found".into()),
                    ms: json!(0),
                });
                continue;
            };
            if self.repeat_guard {
                if self
                    .seen
                    .iter()
                    .any(|(n, i)| *n == c.name && json_eq(i, &c.input))
                {
                    let output = json!({"error": format!("Repeated call: \"{}\" was already called with the same input in this run. Use that result or change the arguments.", c.name)});
                    self.settle(Outcome {
                        call_id: c.call_id,
                        name: c.name,
                        output,
                        failure: Some("denied".into()),
                        ms: json!(0),
                    });
                    continue;
                }
                self.seen.push((c.name.clone(), c.input.clone()));
            }
            if side == "confirm" {
                self.confirm_queue.push(c);
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
        self.settled.push(o);
    }

    /// Everything runs first; confirm tools one at a time after; then the step ends.
    fn advance(&mut self) {
        if !self.running.is_empty() {
            return;
        }
        while !self.confirm_queue.is_empty() {
            let next = self.confirm_queue.remove(0);
            if !self.interactive {
                let output = json!({"error": format!("\"{}\" needs the user's approval and this host cannot ask for it.", next.name)});
                self.settle(Outcome {
                    call_id: next.call_id,
                    name: next.name,
                    output,
                    failure: Some("denied".into()),
                    ms: json!(0),
                });
                continue;
            }
            return self.ask(next);
        }
        self.end_step();
    }

    fn ask(&mut self, next: Call) {
        self.events.push(json!({
            "type": "awaiting-user",
            "callId": next.call_id,
            "card": {"id": format!("approval:{}", next.call_id), "callId": next.call_id, "spec": {"kind": "confirm", "tool": next.name, "input": next.input}}
        }));
        self.effects
            .push(json!({"kind": "ask-user", "callId": next.call_id}));
        self.asking = Some(next);
        self.phase = Phase::Ask;
    }

    fn on_user_action(&mut self, input: &Value) {
        let call_id = input["callId"].as_str().unwrap_or("").to_string();
        let action = input["action"].clone();
        let asked = self.asking.take().expect("checked by feed");
        self.events
            .push(json!({"type": "user-responded", "callId": call_id, "action": action}));
        let kind = action["type"].as_str().unwrap_or("");
        let declined = kind == "cancel" || kind == "dismiss";
        let approved = !declined
            && (action.get("value").is_none() || action["value"]["confirmed"] == json!(true));
        self.phase = Phase::Tools;
        if approved {
            self.effects.push(json!({"kind": "run-tool", "callId": call_id, "name": asked.name, "input": asked.input}));
            self.running.push(call_id);
            return;
        }
        self.settle(Outcome {
            call_id,
            name: asked.name,
            output: json!({"error": USER_DECLINED}),
            failure: Some("denied".into()),
            ms: json!(0),
        });
        self.advance();
    }

    fn end_step(&mut self) {
        let ordered: Vec<Outcome> = self
            .calls
            .iter()
            .filter_map(|c| self.outcome_of(&c.call_id).cloned())
            .collect();
        let parts: Vec<Value> = ordered.iter().map(Outcome::to_part).collect();
        self.effects
            .push(json!({"kind": "append", "message": {"role": "tool", "parts": parts}}));
        self.step += 1;
        self.finish_reason = self.step_finish.clone();
        if self.should_stop(&ordered) {
            self.finish_reason = "stop".into();
            return self.finish_run();
        }
        self.loop_top();
    }

    /// `conditions.some(...)`: evaluated in order, first true wins. A stateful one only updates when reached.
    fn should_stop(&mut self, outcomes: &[Outcome]) -> bool {
        for i in 0..self.stop_when.len() {
            let c = self.stop_when[i].clone();
            let hit = match c["kind"].as_str().unwrap_or("") {
                "stepCountIs" => self.step >= c["n"].as_u64().unwrap_or(0),
                "afterTool" => outcomes.iter().any(|o| {
                    c["names"]
                        .as_array()
                        .is_some_and(|ns| ns.iter().any(|n| n == o.name.as_str()))
                        && o.failure.is_none()
                }),
                "tokenBudgetExceeded" => {
                    let total = self
                        .usage
                        .get("totalTokens")
                        .and_then(Value::as_u64)
                        .unwrap_or_else(|| {
                            self.usage
                                .get("inputTokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(0)
                                + self
                                    .usage
                                    .get("outputTokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0)
                        });
                    total >= c["maxTotal"].as_u64().unwrap_or(u64::MAX)
                }
                "consecutiveFailures" => {
                    let all_failed =
                        !outcomes.is_empty() && outcomes.iter().all(|o| o.failure.is_some());
                    self.streaks[i] = if all_failed { self.streaks[i] + 1 } else { 0 };
                    self.streaks[i] >= c["n"].as_u64().unwrap_or(u64::MAX)
                }
                "userDeclined" => outcomes
                    .iter()
                    .any(|o| is_user_decline(&o.output, o.failure.as_deref())),
                _ => false,
            };
            if hit {
                return true;
            }
        }
        false
    }

    fn finish_run(&mut self) {
        if self.step >= self.max_steps && self.finish_reason == "tool-calls" {
            self.events.push(json!({"type": "message", "parts": [{"type": "notice", "code": "step-limit", "steps": self.max_steps}]}));
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
        let reason = if kind == "cancelled" {
            "cancelled"
        } else {
            "error"
        };
        self.events.push(json!({"type": "run-finish", "runId": self.run_id, "finishReason": reason, "usage": self.usage, "steps": self.attempted}));
        self.effects.push(json!({"kind": "done"}));
        self.phase = Phase::Done;
    }

    // ---- checkpoint and resume ------------------------------------------------------------------------

    /// Everything a new process needs to carry on, as JSON. The cancel flag is not part of it: a cancel belongs to the driver.
    fn checkpoint(&self) -> Value {
        let mut s = json!({
            "v": CHECKPOINT_VERSION,
            "runId": self.run_id,
            "mode": self.mode,
            "step": self.step,
            "attempted": self.attempted,
            "usage": self.usage,
            "streaks": self.streaks,
            "seen": self.seen.iter().map(|(n, i)| json!({"name": n, "input": i})).collect::<Vec<_>>(),
            "phase": self.phase.name(),
        });
        if self.phase == Phase::Model {
            return s;
        }
        s["stepFinish"] = json!(self.step_finish);
        s["calls"] = Value::Array(self.calls.iter().map(Call::to_value).collect());
        s["results"] = Value::Array(self.settled.iter().map(Outcome::to_value).collect());
        // A confirm call that was asked, said yes to, and has not reported back.
        s["approved"] = Value::Array(
            self.calls
                .iter()
                .filter(|c| {
                    self.side_of(&c.name) == Some("confirm") && self.running.contains(&c.call_id)
                })
                .map(|c| json!(c.call_id))
                .collect(),
        );
        if self.phase == Phase::Ask {
            s["asking"] = json!(self.asking.as_ref().map(|a| a.call_id.clone()));
        }
        s
    }

    /// Rebuild the state and re-issue whatever the snapshot was waiting for. Tools run at least once: same callId.
    fn restore(&mut self, state: &Value) -> Result<(), IllegalInput> {
        if state["v"].as_u64() != Some(CHECKPOINT_VERSION) {
            return illegal(format!("a checkpoint of version {}", state["v"]));
        }
        let phase = state["phase"].as_str().unwrap_or("");
        if !["model", "tools", "ask"].contains(&phase) {
            return illegal(format!("a checkpoint in phase {phase}"));
        }
        let arr = |k: &str| state[k].as_array().cloned().unwrap_or_default();
        // Refuse before changing anything: a refused resume leaves the machine as it was.
        if phase == "ask" && !arr("calls").iter().any(|c| c["callId"] == state["asking"]) {
            return illegal("a checkpoint that is asking about a call it does not have");
        }
        self.run_id = state["runId"].as_str().unwrap_or("").to_string();
        self.mode = state["mode"].clone();
        self.step = state["step"].as_u64().unwrap_or(0);
        self.attempted = state["attempted"].as_u64().unwrap_or(0);
        self.usage = state["usage"].clone();
        self.streaks = arr("streaks")
            .iter()
            .map(|n| n.as_u64().unwrap_or(0))
            .collect();
        self.seen = arr("seen")
            .iter()
            .map(|s| {
                (
                    s["name"].as_str().unwrap_or("").to_string(),
                    s["input"].clone(),
                )
            })
            .collect();
        self.cancelled = false;

        if phase == "model" {
            self.phase = Phase::Model;
            self.effects.push(
                json!({"kind": "call-model", "step": self.step, "toolNames": self.tool_names()}),
            );
            return Ok(());
        }

        self.step_finish = state["stepFinish"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        self.calls = arr("calls").iter().map(Call::from_value).collect();
        self.settled = arr("results").iter().map(Outcome::from_value).collect();
        let approved: Vec<String> = arr("approved")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        let asking = state["asking"].as_str().map(str::to_string);
        self.running = vec![];
        self.confirm_queue = vec![];
        self.asking = None;
        self.phase = Phase::Tools;
        let pending: Vec<Call> = self
            .calls
            .iter()
            .filter(|c| self.outcome_of(&c.call_id).is_none())
            .cloned()
            .collect();
        for c in pending {
            if asking.as_deref() == Some(c.call_id.as_str()) {
                continue;
            }
            if self.side_of(&c.name) == Some("confirm") && !approved.contains(&c.call_id) {
                self.confirm_queue.push(c);
            } else {
                self.effects.push(json!({"kind": "run-tool", "callId": c.call_id, "name": c.name, "input": c.input}));
                self.running.push(c.call_id);
            }
        }
        if phase == "ask" {
            let call = self
                .calls
                .iter()
                .find(|c| asking.as_deref() == Some(c.call_id.as_str()))
                .cloned()
                .expect("checked above");
            self.ask(call);
            return Ok(());
        }
        self.advance();
        Ok(())
    }
}
