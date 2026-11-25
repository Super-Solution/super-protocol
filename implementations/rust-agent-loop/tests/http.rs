//! The HTTP transport against a real socket: a server on localhost that answers like a Chat Completions endpoint.
//! Needs `--features http`. The shadow replay (tests/replay.rs) proves the bytes-to-events part; this proves the
//! bytes really travel: a bearer key is sent, a stream is read as it arrives, an error status reaches the provider.
#![cfg(feature = "http")]

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use super_agent_loop::{
    Driver, HttpTransport, OpenAiChat, RunSpec, ToolCtx, ToolDef, ToolError, ToolReturn, ToolSpec,
    Tools,
};

struct Seen {
    request_line: String,
    headers: Vec<(String, String)>,
    body: Value,
}

/// One scripted answer per connection: (status line, body pieces written with a pause between them).
fn serve(answers: Vec<(&'static str, Vec<String>)>) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let log = seen.clone();
    std::thread::spawn(move || {
        for (status, pieces) in answers {
            let (mut sock, _) = listener.accept().unwrap();
            log.lock().unwrap().push(read_request(&mut sock));
            let ctype = if status.starts_with("200") {
                "text/event-stream"
            } else {
                "application/json"
            };
            write!(
                sock,
                "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            for p in pieces {
                sock.write_all(p.as_bytes()).unwrap();
                sock.flush().unwrap();
                std::thread::sleep(Duration::from_millis(20)); // the client must read the first piece before the second exists
            }
        }
    });
    (url, seen)
}

fn read_request(sock: &mut TcpStream) -> Seen {
    let mut buf = vec![];
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        sock.read_exact(&mut byte).unwrap();
        buf.push(byte[0]);
    }
    let head = String::from_utf8(buf).unwrap();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap().to_string();
    let headers: Vec<(String, String)> = lines
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (k, v) = l.split_once(':').unwrap();
            (k.trim().to_lowercase(), v.trim().to_string())
        })
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .map(|(_, v)| v.parse().unwrap())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    sock.read_exact(&mut body).unwrap();
    Seen {
        request_line,
        headers,
        body: serde_json::from_slice(&body).unwrap(),
    }
}

fn frame(v: Value) -> String {
    format!("data: {v}\n\n")
}

fn chunk(delta: Value, finish: Value) -> Value {
    json!({"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "m", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
}

struct Echo;
impl Tools for Echo {
    fn execute(&self, _name: &str, input: &Value, _ctx: &ToolCtx) -> Result<ToolReturn, ToolError> {
        Ok(ToolReturn {
            output: json!({"echoed": input["text"]}),
            failure: None,
        })
    }
}

fn spec() -> RunSpec {
    RunSpec {
        run_id: "run_1".into(),
        system: Some("You are a test agent.".into()),
        tools: vec![ToolDef {
            spec: ToolSpec {
                name: "echo".into(),
                description: "Echo.".into(),
                parameters: json!({"type": "object", "properties": {"text": {"type": "string"}}}),
                strict: false,
            },
            side: "read".into(),
        }],
        ..RunSpec::default()
    }
}

fn user(text: &str) -> Vec<Value> {
    vec![json!({"role": "user", "parts": [{"type": "text", "text": text}]})]
}

#[test]
fn a_two_step_run_over_a_socket() {
    let first = vec![
        frame(chunk(
            json!({"tool_calls": [{"index": 0, "id": "call_a", "type": "function", "function": {"name": "echo", "arguments": "{\"te"}}]}),
            Value::Null,
        )),
        // the frame below is cut in the middle: the decoder must wait for the rest
        format!(
            "data: {}",
            &chunk(
                json!({"tool_calls": [{"index": 0, "function": {"arguments": "xt\":\"hi\"}"}}]}),
                Value::Null
            )
            .to_string()[..30]
        ),
        format!(
            "{}\n\n",
            &chunk(
                json!({"tool_calls": [{"index": 0, "function": {"arguments": "xt\":\"hi\"}"}}]}),
                Value::Null
            )
            .to_string()[30..]
        ),
        frame(chunk(json!({}), json!("tool_calls"))),
        frame(
            json!({"id": "c1", "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}),
        ),
        "data: [DONE]\n\n".into(),
    ];
    let second = vec![
        frame(chunk(json!({"content": "Said hi."}), Value::Null)),
        frame(chunk(json!({}), json!("stop"))),
        "data: [DONE]\n\n".into(),
    ];
    let (url, seen) = serve(vec![("200 OK", first), ("200 OK", second)]);

    let model = OpenAiChat::new(
        HttpTransport::new(format!("{url}/v1")).with_api_key("sk-test"),
        "m",
    );
    let driver = Driver {
        model: &model,
        tools: &Echo,
        person: None,
        spec: spec(),
    };
    let out = driver
        .run(user("Echo hi."), &AtomicBool::new(false))
        .unwrap();

    let types: Vec<&str> = out
        .events
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        [
            "run-start",
            "step-start",
            "usage",
            "step-finish",
            "tool-call",
            "tool-result",
            "step-start",
            "text-delta",
            "usage",
            "step-finish",
            "run-finish"
        ]
    );
    assert_eq!(out.events[4]["input"], json!({"text": "hi"}));
    assert_eq!(out.events[5]["output"], json!({"echoed": "hi"}));
    assert_eq!(out.events[7]["delta"], "Said hi.");
    assert_eq!(out.events[10]["finishReason"], "stop");

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].request_line, "POST /v1/chat/completions HTTP/1.1");
    assert!(seen[0]
        .headers
        .contains(&("authorization".into(), "Bearer sk-test".into())));
    assert!(seen[0]
        .headers
        .contains(&("content-type".into(), "application/json".into())));
    assert_eq!(seen[0].body["stream"], true);
    assert_eq!(
        seen[1].body["messages"].as_array().unwrap().last().unwrap(),
        &json!({"role": "tool", "tool_call_id": "call_a", "content": "{\"echoed\":\"hi\"}"})
    );
}

#[test]
fn an_error_status_is_the_providers_own_message() {
    let body = json!({"error": {"message": "Incorrect API key provided.", "type": "invalid_request_error"}}).to_string();
    let (url, _) = serve(vec![("401 Unauthorized", vec![body])]);
    let model = OpenAiChat::new(HttpTransport::new(url).with_api_key("sk-wrong"), "m");
    let driver = Driver {
        model: &model,
        tools: &Echo,
        person: None,
        spec: spec(),
    };
    let out = driver.run(user("Hi."), &AtomicBool::new(false)).unwrap();
    let err = out.events.iter().find(|e| e["type"] == "error").unwrap();
    assert_eq!(
        err["error"],
        json!({"kind": "auth", "message": "Incorrect API key provided."})
    );
    assert_eq!(out.events.last().unwrap()["finishReason"], "error");
}

#[test]
fn an_unreachable_server_is_a_network_error() {
    let port = {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }; // free, and nothing listens
    let model = OpenAiChat::new(HttpTransport::new(format!("http://127.0.0.1:{port}")), "m");
    let driver = Driver {
        model: &model,
        tools: &Echo,
        person: None,
        spec: spec(),
    };
    let out = driver.run(user("Hi."), &AtomicBool::new(false)).unwrap();
    let err = out.events.iter().find(|e| e["type"] == "error").unwrap();
    assert_eq!(err["error"]["kind"], "network");
}
