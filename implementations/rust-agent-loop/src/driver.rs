//! The driver: what runs a [`LoopMachine`]. It does the effects the machine asks for (call the model, run a tool, ask
//! the person), feeds the answers back, keeps the history, and collects the events. Everything it needs from the
//! outside world is a trait, so a test is a script and a host is a few `impl`s.
//!
//! Threads, not an async runtime: a step's tools run in parallel on scoped threads and are fed back in the order
//! they *finish* (the machine reports `tool-result` events in completion order and writes the history in call
//! order, see `docs/AGENT-LOOP.md` rule 4). The model call and the person's answer block the driver's thread, which
//! is all a turn does while it waits. A host that wants Tokio calls this from `spawn_blocking` or writes its own
//! driver: the machine does not care.
//!
//! The tool layer of Super Chat's `execute-tools.ts` that the machine does not own is here too, because the model reads
//! its output: a tool that throws becomes a `failure: "execution-error"` result with a short error and a `kind`,
//! and a failed call that left out required arguments is told which (`missing`, `expected`).

use crate::machine::{IllegalInput, LoopMachine, Step};
use crate::repair::take_utf16;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

// ---- the model ----------------------------------------------------------------------------------------------------------

/// A tool as the model is told about it.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments.
    pub parameters: Value,
    pub strict: bool,
}

/// One model call: the history so far, the tools it may use this step.
#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub step: u64,
    pub system: Option<String>,
    /// Messages of typed parts (`role`, `parts`), without the system prompt.
    pub messages: Vec<Value>,
    pub tools: Vec<ToolSpec>,
}

/// What one model call produced: `text` and `tool-call` parts (already repaired), a finish reason, usage.
#[derive(Debug, Clone)]
pub struct ModelResult {
    pub parts: Vec<Value>,
    pub finish_reason: String,
    pub usage: Value,
}

/// A model call that failed. `kind` is Super Chat's: `auth`, `rate-limit`, `timeout`, `invalid-request`,
/// `context-length`, `content-filter`, `overloaded`, `network`, `cancelled`, `unknown`.
#[derive(Debug, Clone)]
pub struct ModelFailure {
    pub kind: String,
    pub message: String,
    pub usage: Option<Value>,
}

pub trait Model: Send + Sync {
    fn call(&self, request: &ModelRequest) -> Result<ModelResult, ModelFailure>;
}

// ---- the tools ----------------------------------------------------------------------------------------------------------

/// A tool the host offers. `side` is `read`, `draft`, `act` or `confirm` (a `confirm` tool waits for the person).
#[derive(Debug, Clone)]
pub struct ToolDef {
    pub spec: ToolSpec,
    pub side: String,
}

pub struct ToolCtx<'a> {
    pub call_id: &'a str,
    /// Set when the run was cancelled. A tool that can stop early should.
    pub cancel: &'a AtomicBool,
}

/// What a tool returns when it did not throw. `failure` names a failure the tool reports itself (`denied`, ...).
#[derive(Debug, Clone)]
pub struct ToolReturn {
    pub output: Value,
    pub failure: Option<String>,
}

/// What a tool "throws". `kind` is optional: without one it is read from the message, as Super Chat does.
#[derive(Debug, Clone)]
pub struct ToolError {
    pub kind: Option<String>,
    pub message: String,
}

/// Tools run at least once per call and may run in parallel: they must be `Sync`, and idempotent where a resume can
/// re-issue them (the `callId` stays the same).
pub trait Tools: Send + Sync {
    fn execute(&self, name: &str, input: &Value, ctx: &ToolCtx) -> Result<ToolReturn, ToolError>;
}

/// The person, for `confirm` tools in an interactive run. Gets the approval card; answers with an action
/// `{ type: "submit" | "cancel" | "dismiss", value? }`.
pub trait Person {
    fn answer(&self, card: &Value) -> Value;
}

// ---- the run ------------------------------------------------------------------------------------------------------------

/// What differs from run to run.
#[derive(Clone, Default)]
pub struct RunSpec {
    pub run_id: String,
    pub system: Option<String>,
    pub tools: Vec<ToolDef>,
    pub max_steps: Option<u64>,
    /// Stop conditions as data, see `docs/AGENT-LOOP.md` rule 7.
    pub stop_when: Vec<Value>,
    pub interactive: bool,
    pub repeat_guard: bool,
}

#[derive(Debug)]
pub struct RunOutput {
    pub events: Vec<Value>,
    /// The messages the model saw at the end: what was passed in, then every `append` of the machine.
    pub history: Vec<Value>,
}

pub struct Driver<'a> {
    pub model: &'a dyn Model,
    pub tools: &'a dyn Tools,
    pub person: Option<&'a dyn Person>,
    pub spec: RunSpec,
}

impl<'a> Driver<'a> {
    fn machine_config(&self) -> Value {
        let mut c = Map::new();
        c.insert(
            "tools".into(),
            Value::Array(
                self.spec
                    .tools
                    .iter()
                    .map(|t| json!({"name": t.spec.name, "side": t.side}))
                    .collect(),
            ),
        );
        if let Some(n) = self.spec.max_steps {
            c.insert("maxSteps".into(), json!(n));
        }
        if !self.spec.stop_when.is_empty() {
            c.insert("stopWhen".into(), Value::Array(self.spec.stop_when.clone()));
        }
        c.insert("interactive".into(), json!(self.spec.interactive));
        c.insert("repeatGuard".into(), json!(self.spec.repeat_guard));
        Value::Object(c)
    }

    /// Run one turn to its `run-finish`. `cancel` may be set from another thread at any time.
    pub fn run(
        &self,
        messages: Vec<Value>,
        cancel: &AtomicBool,
    ) -> Result<RunOutput, IllegalInput> {
        let mut machine = LoopMachine::new(&self.machine_config());
        let mut events: Vec<Value> = vec![];
        let mut history = messages;
        let mut cards: HashMap<String, Value> = HashMap::new();
        let mut queue: VecDeque<Value> = VecDeque::new();
        let mut cancel_sent = false;
        let mut outstanding = 0usize;
        let defs: HashMap<&str, &ToolDef> = self
            .spec
            .tools
            .iter()
            .map(|t| (t.spec.name.as_str(), t))
            .collect();
        let (tx, rx) = mpsc::channel::<Value>();

        let mut next = Some(
            json!({"kind": "start", "runId": self.spec.run_id, "mode": "stream", "messages": history}),
        );

        std::thread::scope(|scope| -> Result<(), IllegalInput> {
            loop {
                // A cancel goes in before anything else that is waiting: the machine ends the run at the top of its next
                // step, and an outcome fed first would let that step begin.
                if cancel.load(Ordering::SeqCst) && !cancel_sent {
                    cancel_sent = true;
                    absorb(
                        machine.feed(&json!({"kind": "cancel"}))?,
                        &mut events,
                        &mut queue,
                        &mut cards,
                    );
                }
                if let Some(input) = next.take() {
                    absorb(machine.feed(&input)?, &mut events, &mut queue, &mut cards);
                }
                let Some(effect) = queue.pop_front() else {
                    if outstanding == 0 {
                        return Ok(());
                    }
                    // Poll: a cancel raised while tools run is fed within this interval, not when the slowest one ends.
                    match rx.recv_timeout(CANCEL_POLL) {
                        Ok(outcome) => {
                            outstanding -= 1;
                            next = Some(outcome);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            unreachable!("the driver holds a sender")
                        }
                    }
                    continue;
                };
                match effect["kind"].as_str().unwrap_or("") {
                    "append" => history.push(effect["message"].clone()),
                    "call-model" => {
                        let step_no = effect["step"].as_u64().unwrap_or(0);
                        let names: Vec<&str> = effect["toolNames"]
                            .as_array()
                            .map(|a| a.iter().filter_map(Value::as_str).collect())
                            .unwrap_or_default();
                        let request = ModelRequest {
                            step: step_no,
                            system: self.spec.system.clone(),
                            messages: history.clone(),
                            tools: {
                                let mut specs: Vec<ToolSpec> = self
                                    .spec
                                    .tools
                                    .iter()
                                    .filter(|t| names.contains(&t.spec.name.as_str()))
                                    .map(|t| t.spec.clone())
                                    .collect();
                                // The request lists tools in one order whatever order the host registered them in: same
                                // input, same request, or prompt caching never hits.
                                specs.sort_by(|a, b| locale_compare(&a.name, &b.name));
                                specs
                            },
                        };
                        next = Some(match self.model.call(&request) {
                            Ok(r) => {
                                json!({"kind": "model-result", "parts": r.parts, "finishReason": r.finish_reason, "usage": r.usage})
                            }
                            Err(f) => {
                                let mut v = json!({"kind": "model-error", "error": {"kind": f.kind, "message": f.message}});
                                if let Some(u) = f.usage {
                                    v["usage"] = u;
                                }
                                v
                            }
                        });
                    }
                    "run-tool" => {
                        let call_id = effect["callId"].as_str().unwrap_or("").to_string();
                        let name = effect["name"].as_str().unwrap_or("").to_string();
                        let input = effect["input"].clone();
                        let def = defs.get(name.as_str()).copied();
                        let tx = tx.clone();
                        let tools = self.tools;
                        outstanding += 1;
                        scope.spawn(move || {
                            let started = Instant::now();
                            let ctx = ToolCtx { call_id: &call_id, cancel };
                            let result = catch_unwind(AssertUnwindSafe(|| tools.execute(&name, &input, &ctx)))
                                .unwrap_or_else(|_| Err(ToolError { kind: None, message: format!("Tool \"{name}\" panicked.") }));
                            let (mut output, failure) = match result {
                                Ok(r) => (r.output, r.failure),
                                Err(e) => (compact_error(&e), Some("execution-error".to_string())),
                            };
                            if let Some(def) = def {
                                output = explain_missing_input(def, &input, output, failure.as_deref());
                            }
                            let mut outcome = json!({"kind": "tool-outcome", "callId": call_id, "output": output, "ms": started.elapsed().as_millis() as u64});
                            if let Some(f) = failure {
                                outcome["failure"] = json!(f);
                            }
                            let _ = tx.send(outcome);
                        });
                    }
                    "ask-user" => {
                        let call_id = effect["callId"].as_str().unwrap_or("").to_string();
                        let card = cards.get(&call_id).cloned().unwrap_or(Value::Null);
                        // No person to ask is a no: anything short of an explicit yes is.
                        let action = self
                            .person
                            .map(|p| p.answer(&card))
                            .unwrap_or_else(|| json!({"type": "cancel"}));
                        next = Some(
                            json!({"kind": "user-action", "callId": call_id, "action": action}),
                        );
                    }
                    "done" => return Ok(()),
                    _ => {} // `checkpoint`: this driver does not ask for snapshots
                }
            }
        })?;
        Ok(RunOutput { events, history })
    }
}

// ---- ordering ---------------------------------------------------------------------------------------------------------------

/// The ASCII order of ICU's root collation, as `String.prototype.localeCompare` gives it: whitespace, punctuation,
/// symbols, digits, then letters with a lowercase letter before its uppercase. Super Chat lists tools in this order
/// (`ToolRegistry`); it is not byte order (`_` sorts before digits and digits before letters, `a` before `B`).
const COLLATION_PUNCT: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";

fn primary(c: char) -> u32 {
    if let Some(i) = COLLATION_PUNCT.find(c) {
        return i as u32;
    }
    if c.is_ascii_alphabetic() {
        return 100 + (c.to_ascii_lowercase() as u32 - 'a' as u32);
    }
    1000 + c as u32 // outside ASCII this is code point order, not ICU's: tool names are ASCII
}

/// `a.localeCompare(b)` for tool names: the whole string by primary weight first, case only to break a tie.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let p = |s: &str| s.chars().map(primary).collect::<Vec<_>>();
    let t = |s: &str| {
        s.chars()
            .map(|c| u32::from(c.is_ascii_uppercase()))
            .collect::<Vec<_>>()
    };
    p(a).cmp(&p(b)).then_with(|| t(a).cmp(&t(b)))
}

/// Feed a step's events and effects into the run.
fn absorb(
    step: Step,
    events: &mut Vec<Value>,
    queue: &mut VecDeque<Value>,
    cards: &mut HashMap<String, Value>,
) {
    for e in &step.events {
        if e["type"] == "awaiting-user" {
            if let Some(id) = e["callId"].as_str() {
                cards.insert(id.to_string(), e["card"].clone());
            }
        }
    }
    events.extend(step.events);
    queue.extend(step.effects);
}

const CANCEL_POLL: Duration = Duration::from_millis(25);

// ---- the tool layer ------------------------------------------------------------------------------------------------------

const MAX_ERROR_CHARS: usize = 400;
const MAX_DESCRIBED: usize = 200;

/// `toAgentError` for a message: the kind Super Chat reads from the words when the thrower gave none.
fn kind_from_message(message: &str) -> &'static str {
    let m = message.to_lowercase();
    if m.contains("timeout") || m.contains("etimedout") || m.contains("timed out") {
        return "timeout";
    }
    for w in [
        "fetch failed",
        "econnreset",
        "enotfound",
        "econnrefused",
        "network",
        "socket hang up",
    ] {
        if m.contains(w) {
            return "network";
        }
    }
    "unknown"
}

/// `compactError`: what a thrown error becomes in history.
pub fn compact_error(e: &ToolError) -> Value {
    let kind = e
        .kind
        .clone()
        .unwrap_or_else(|| kind_from_message(&e.message).to_string());
    json!({"error": take_utf16(&e.message, MAX_ERROR_CHARS), "kind": kind})
}

fn describe_property(raw: &Value) -> Value {
    let Some(p) = raw.as_object() else {
        return json!({});
    };
    let mut d = Map::new();
    for k in ["type", "enum", "minimum", "maximum"] {
        if let Some(v) = p.get(k) {
            d.insert(k.into(), v.clone());
        }
    }
    if let Some(desc) = p.get("description").and_then(Value::as_str) {
        let len16 = desc.encode_utf16().count();
        d.insert(
            "description".into(),
            json!(if len16 > MAX_DESCRIBED {
                format!("{}…", take_utf16(desc, MAX_DESCRIBED))
            } else {
                desc.to_string()
            }),
        );
    }
    Value::Object(d)
}

/// `explainMissingInput`: a failed call that left out arguments the tool requires is told which, and what each
/// should be, next to whatever the tool said. Additive: never a rewrite, never on a call that succeeded.
pub fn explain_missing_input(
    tool: &ToolDef,
    input: &Value,
    output: Value,
    failure: Option<&str>,
) -> Value {
    if matches!(failure, Some("denied" | "timeout" | "not-found")) {
        return output;
    }
    let Some(out) = output.as_object() else {
        return output;
    };
    let failed = failure.is_some()
        || (out.get("error").is_some_and(Value::is_string) && out.get("ok") != Some(&json!(true)));
    if !failed || out.contains_key("missing") || out.contains_key("expected") {
        return output;
    }
    let required: Vec<&str> = tool.spec.parameters["required"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if required.is_empty() {
        return output;
    }
    let given = input.as_object();
    let missing: Vec<&str> = required
        .into_iter()
        .filter(|k| given.and_then(|g| g.get(*k)).is_none_or(Value::is_null))
        .collect();
    if missing.is_empty() {
        return output;
    }
    let props = tool.spec.parameters["properties"].as_object();
    let mut expected = Map::new();
    for key in &missing {
        expected.insert(
            (*key).into(),
            describe_property(props.and_then(|p| p.get(*key)).unwrap_or(&Value::Null)),
        );
    }
    let mut merged = out.clone();
    merged.insert("missing".into(), json!(missing));
    merged.insert("expected".into(), Value::Object(expected));
    Value::Object(merged)
}
