//! The driver without a provider: a scripted model and scripted tools, for what the replay data cannot express
//! (a cancel that arrives from another thread, a tool that panics, a person who is not there).

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use super_agent_loop::{
    Driver, Model, ModelFailure, ModelRequest, ModelResult, RunSpec, ToolCtx, ToolDef, ToolError,
    ToolReturn, ToolSpec, Tools,
};

/// Answers each call from a list; a call past the list fails the test.
struct Script(Vec<Result<ModelResult, ModelFailure>>, AtomicUsize);
impl Model for Script {
    fn call(&self, _r: &ModelRequest) -> Result<ModelResult, ModelFailure> {
        self.0[self.1.fetch_add(1, Ordering::SeqCst)].clone()
    }
}

fn calls(parts: Vec<Value>) -> Result<ModelResult, ModelFailure> {
    Ok(ModelResult {
        parts,
        finish_reason: "tool-calls".into(),
        usage: json!({"inputTokens": 1}),
    })
}
fn call(id: &str, name: &str) -> Value {
    json!({"type": "tool-call", "callId": id, "name": name, "input": {}})
}
fn def(name: &str, side: &str) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.into(),
            description: String::new(),
            parameters: json!({"type": "object"}),
            strict: false,
        },
        side: side.into(),
    }
}
fn spec(tools: Vec<ToolDef>) -> RunSpec {
    RunSpec {
        run_id: "r".into(),
        tools,
        ..RunSpec::default()
    }
}
fn types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|e| e["type"].as_str().unwrap().to_string())
        .collect()
}

struct FnTools<F: Fn(&str, &ToolCtx) -> Result<ToolReturn, ToolError> + Send + Sync>(F);
impl<F: Fn(&str, &ToolCtx) -> Result<ToolReturn, ToolError> + Send + Sync> Tools for FnTools<F> {
    fn execute(&self, name: &str, _i: &Value, ctx: &ToolCtx) -> Result<ToolReturn, ToolError> {
        (self.0)(name, ctx)
    }
}
fn ok(v: Value) -> Result<ToolReturn, ToolError> {
    Ok(ToolReturn {
        output: v,
        failure: None,
    })
}

#[test]
fn a_cancel_raised_while_a_tool_runs_ends_the_run_before_the_next_step() {
    let cancel = AtomicBool::new(false);
    let model = Script(vec![calls(vec![call("c1", "t")])], AtomicUsize::new(0));
    let tools = FnTools(|_, ctx: &ToolCtx| {
        ctx.cancel.store(true, Ordering::SeqCst); // what another thread's "stop" button does
        std::thread::sleep(std::time::Duration::from_millis(30));
        ok(json!("done"))
    });
    let d = Driver {
        model: &model,
        tools: &tools,
        person: None,
        spec: spec(vec![def("t", "read")]),
    };
    let out = d.run(vec![], &cancel).unwrap();
    // the tool's result stands, the second model call is never made, and the run says why
    assert_eq!(
        types(&out.events),
        [
            "run-start",
            "step-start",
            "usage",
            "step-finish",
            "tool-call",
            "tool-result",
            "error",
            "run-finish"
        ]
    );
    assert_eq!(out.events[6]["error"]["kind"], "cancelled");
    assert_eq!(out.events[7]["finishReason"], "cancelled");
    assert_eq!(model.1.load(Ordering::SeqCst), 1);
}

#[test]
fn tool_results_arrive_in_completion_order_and_the_history_keeps_call_order() {
    let model = Script(
        vec![
            calls(vec![call("slow", "t"), call("fast", "t")]),
            Ok(ModelResult {
                parts: vec![],
                finish_reason: "stop".into(),
                usage: json!({}),
            }),
        ],
        AtomicUsize::new(0),
    );
    let tools = FnTools(|_, ctx: &ToolCtx| {
        std::thread::sleep(std::time::Duration::from_millis(if ctx.call_id == "slow" {
            80
        } else {
            5
        }));
        ok(json!(ctx.call_id))
    });
    let d = Driver {
        model: &model,
        tools: &tools,
        person: None,
        spec: spec(vec![def("t", "read")]),
    };
    let out = d.run(vec![], &AtomicBool::new(false)).unwrap();
    let order: Vec<&str> = out
        .events
        .iter()
        .filter(|e| e["type"] == "tool-result")
        .map(|e| e["callId"].as_str().unwrap())
        .collect();
    assert_eq!(order, ["fast", "slow"]);
    let tool_msg = out.history.iter().find(|m| m["role"] == "tool").unwrap();
    let in_history: Vec<&str> = tool_msg["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["callId"].as_str().unwrap())
        .collect();
    assert_eq!(in_history, ["slow", "fast"]);
}

#[test]
fn a_tool_that_panics_is_a_failed_result_not_a_dead_run() {
    let model = Script(
        vec![
            calls(vec![call("c1", "t")]),
            Ok(ModelResult {
                parts: vec![],
                finish_reason: "stop".into(),
                usage: json!({}),
            }),
        ],
        AtomicUsize::new(0),
    );
    let tools = FnTools(|_, _: &ToolCtx| -> Result<ToolReturn, ToolError> { panic!("boom") });
    let d = Driver {
        model: &model,
        tools: &tools,
        person: None,
        spec: spec(vec![def("t", "read")]),
    };
    let out = d.run(vec![], &AtomicBool::new(false)).unwrap();
    let r = out
        .events
        .iter()
        .find(|e| e["type"] == "tool-result")
        .unwrap();
    assert_eq!(r["failure"], "execution-error");
    assert_eq!(r["output"]["error"], "Tool \"t\" panicked.");
    assert_eq!(out.events.last().unwrap()["finishReason"], "stop");
}

#[test]
fn a_confirm_tool_with_nobody_to_ask_is_declined_and_never_runs() {
    let model = Script(
        vec![
            calls(vec![call("c1", "send")]),
            Ok(ModelResult {
                parts: vec![],
                finish_reason: "stop".into(),
                usage: json!({}),
            }),
        ],
        AtomicUsize::new(0),
    );
    let ran = AtomicBool::new(false);
    let tools = FnTools(|_, _: &ToolCtx| {
        ran.store(true, Ordering::SeqCst);
        ok(json!("sent"))
    });
    let mut s = spec(vec![def("send", "confirm")]);
    s.interactive = true;
    let d = Driver {
        model: &model,
        tools: &tools,
        person: None,
        spec: s,
    };
    let out = d.run(vec![], &AtomicBool::new(false)).unwrap();
    assert!(!ran.load(Ordering::SeqCst));
    let r = out
        .events
        .iter()
        .find(|e| e["type"] == "tool-result")
        .unwrap();
    assert_eq!(
        (r["failure"].as_str(), r["output"]["error"].as_str()),
        (Some("denied"), Some("The user declined."))
    );
}

#[test]
fn a_failed_model_call_keeps_the_usage_it_reported() {
    let model = Script(
        vec![Err(ModelFailure {
            kind: "overloaded".into(),
            message: "busy".into(),
            usage: Some(json!({"inputTokens": 7})),
        })],
        AtomicUsize::new(0),
    );
    let tools = FnTools(|_, _: &ToolCtx| ok(json!(null)));
    let d = Driver {
        model: &model,
        tools: &tools,
        person: None,
        spec: spec(vec![]),
    };
    let out = d.run(vec![], &AtomicBool::new(false)).unwrap();
    assert_eq!(
        types(&out.events),
        ["run-start", "step-start", "usage", "error", "run-finish"]
    );
    assert_eq!(out.events[4]["usage"], json!({"inputTokens": 7}));
}

#[test]
fn only_the_tools_of_the_step_are_declared_to_the_model() {
    struct Spy(std::sync::Mutex<Vec<Vec<String>>>);
    impl Model for Spy {
        fn call(&self, r: &ModelRequest) -> Result<ModelResult, ModelFailure> {
            self.0
                .lock()
                .unwrap()
                .push(r.tools.iter().map(|t| t.name.clone()).collect());
            Ok(ModelResult {
                parts: vec![],
                finish_reason: "stop".into(),
                usage: json!({}),
            })
        }
    }
    let model = Spy(Default::default());
    let tools = FnTools(|_, _: &ToolCtx| ok(json!(null)));
    let d = Driver {
        model: &model,
        tools: &tools,
        person: None,
        spec: spec(vec![def("zeta", "read"), def("alpha", "read")]),
    };
    d.run(vec![], &AtomicBool::new(false)).unwrap();
    assert_eq!(model.0.lock().unwrap()[0], ["alpha", "zeta"]);
}
