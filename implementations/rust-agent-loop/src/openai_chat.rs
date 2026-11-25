//! The OpenAI Chat Completions dialect, streaming: the request a history becomes, and the model result a stream
//! becomes. It is the dialect every OpenAI-compatible server speaks (Super Router, vLLM, Ollama, Groq ...), so it is
//! the one provider of this crate.
//!
//! A port of Super Chat's `providers/openai/{map-in,stream,map-out}.ts` and `transport/{sse,retry}.ts`, held to them by
//! `conformance/agent-loop-replay.v0.json`: the same bytes must give the same model result, the same history must give
//! the same request body, and the same HTTP failure must give the same error. What it leaves out (images, files,
//! audio, reasoning, provider-native tools, retries, the Responses dialect) is listed in the README, not guessed at.

use crate::driver::{Model, ModelFailure, ModelRequest, ModelResult, ToolSpec};
use crate::repair::{repair_tool_arguments, take_utf16};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::Read;

// ---- the request --------------------------------------------------------------------------------------------------

fn stringify_output(output: &Value) -> String {
    match output {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".into()),
    }
}

fn text_parts(parts: &[Value]) -> impl Iterator<Item = &str> {
    parts
        .iter()
        .filter(|p| p["type"] == "text")
        .filter_map(|p| p["text"].as_str())
}

fn parts_of(m: &Value) -> &[Value] {
    m["parts"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// `toChatMessages`: Super Chat history (messages of typed parts) to Chat Completions messages.
pub fn to_chat_messages(messages: &[Value], system: Option<&str>) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    if let Some(s) = system.filter(|s| !s.is_empty()) {
        out.push(json!({"role": "system", "content": s}));
    }
    for m in messages {
        let parts = parts_of(m);
        match m["role"].as_str().unwrap_or("") {
            "system" => {
                let text = text_parts(parts).collect::<Vec<_>>().join("\n");
                if !text.is_empty() {
                    out.push(json!({"role": "system", "content": text}));
                }
            }
            "assistant" => {
                let text: String = text_parts(parts).collect();
                let calls: Vec<Value> = parts
                    .iter()
                    .filter(|p| p["type"] == "tool-call")
                    .map(|p| {
                        let arguments = match &p["input"] {
                            Value::String(s) => s.clone(),
                            Value::Null => "{}".to_string(),
                            other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
                        };
                        json!({"id": p["callId"], "type": "function", "function": {"name": p["name"], "arguments": arguments}})
                    })
                    .collect();
                if !text.is_empty() || !calls.is_empty() {
                    let mut msg = Map::new();
                    msg.insert("role".into(), json!("assistant"));
                    msg.insert(
                        "content".into(),
                        if text.is_empty() {
                            Value::Null
                        } else {
                            json!(text)
                        },
                    );
                    if !calls.is_empty() {
                        msg.insert("tool_calls".into(), Value::Array(calls));
                    }
                    out.push(Value::Object(msg));
                }
                for p in parts.iter().filter(|p| p["type"] == "tool-result") {
                    out.push(json!({"role": "tool", "tool_call_id": p["callId"], "content": stringify_output(&p["output"])}));
                }
            }
            _ => {
                for p in parts.iter().filter(|p| p["type"] == "tool-result") {
                    out.push(json!({"role": "tool", "tool_call_id": p["callId"], "content": stringify_output(&p["output"])}));
                }
                let content: Vec<Value> = text_parts(parts)
                    .map(|t| json!({"type": "text", "text": t}))
                    .collect();
                if content.len() == 1 {
                    out.push(json!({"role": "user", "content": content[0]["text"]}));
                } else if !content.is_empty() {
                    out.push(json!({"role": "user", "content": content}));
                }
            }
        }
    }
    drop_orphan_tool_calls(out)
}

/// An assistant `tool_calls` entry with no `role: "tool"` reply is a 400 at the provider: drop it.
fn drop_orphan_tool_calls(messages: Vec<Value>) -> Vec<Value> {
    let answered: HashSet<String> = messages
        .iter()
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["tool_call_id"].as_str().map(str::to_string))
        .collect();
    messages
        .into_iter()
        .filter_map(|mut m| {
            let Some(calls) = m
                .get("tool_calls")
                .and_then(Value::as_array)
                .filter(|c| !c.is_empty())
            else {
                return Some(m);
            };
            let kept: Vec<Value> = calls
                .iter()
                .filter(|c| c["id"].as_str().is_some_and(|id| answered.contains(id)))
                .cloned()
                .collect();
            if kept.len() == calls.len() {
                return Some(m);
            }
            if kept.is_empty() {
                let obj = m.as_object_mut().unwrap();
                obj.remove("tool_calls");
                let has_content = match obj.get("content") {
                    Some(Value::Null) | None => false,
                    Some(Value::String(s)) => !s.is_empty(),
                    Some(_) => true,
                };
                return has_content.then_some(m);
            }
            m["tool_calls"] = Value::Array(kept);
            Some(m)
        })
        .collect()
}

/// `buildChatRequest` for a streamed turn: the body to POST to `/chat/completions`.
pub fn build_request(
    model: &str,
    system: Option<&str>,
    messages: &[Value],
    tools: &[ToolSpec],
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert(
        "messages".into(),
        Value::Array(to_chat_messages(messages, system)),
    );
    if !tools.is_empty() {
        let decls: Vec<Value> = tools
            .iter()
            .map(|t| {
                let mut f = Map::new();
                f.insert("name".into(), json!(t.name));
                f.insert("description".into(), json!(t.description));
                f.insert("parameters".into(), t.parameters.clone());
                if t.strict {
                    f.insert("strict".into(), json!(true));
                }
                json!({"type": "function", "function": Value::Object(f)})
            })
            .collect();
        body.insert("tools".into(), Value::Array(decls));
        body.insert("parallel_tool_calls".into(), json!(true));
        body.insert("tool_choice".into(), json!("auto"));
    }
    body.insert("stream".into(), json!(true));
    // Usage is left out of a streamed response unless asked for: without this every turn meters as zero tokens.
    body.insert("stream_options".into(), json!({"include_usage": true}));
    Value::Object(body)
}

// ---- server-sent events (WHATWG event-stream algorithm) -------------------------------------------------------------

/// One dispatched event. Only `data` matters to this dialect.
#[derive(Debug, Clone, PartialEq)]
pub struct SseMessage {
    pub event: String,
    pub data: String,
}

/// Incremental decoder: bytes in (any split, mid-line, mid-character), events out. State is per instance.
#[derive(Default)]
pub struct SseDecoder {
    bytes: Vec<u8>, // an incomplete UTF-8 sequence at the end of the last read
    buffer: String, // text not yet terminated by a line end
    event: String,
    data: Vec<String>,
}

/// The length of the incomplete UTF-8 sequence at the end of `b` (0 when it ends on a character boundary).
fn incomplete_tail(b: &[u8]) -> usize {
    for back in 1..=b.len().min(3) {
        let byte = b[b.len() - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue; // a continuation byte: keep looking for its lead
        }
        let need = match byte {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed the next read of the body; returns the events it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseMessage> {
        self.bytes.extend_from_slice(chunk);
        let keep = incomplete_tail(&self.bytes);
        let split = self.bytes.len() - keep;
        // An invalid sequence becomes U+FFFD, as `TextDecoder` does.
        self.buffer
            .push_str(&String::from_utf8_lossy(&self.bytes[..split]));
        self.bytes.drain(..split);
        self.drain_lines(false)
    }

    /// The body ended: a last line without its terminator, and an event without its blank line, still count.
    pub fn finish(&mut self) -> Vec<SseMessage> {
        if !self.bytes.is_empty() {
            self.buffer.push_str(&String::from_utf8_lossy(&self.bytes));
            self.bytes.clear();
        }
        let mut out = self.drain_lines(true);
        out.extend(self.flush());
        out
    }

    fn drain_lines(&mut self, at_end: bool) -> Vec<SseMessage> {
        let mut out = vec![];
        let mut offset = 0;
        let buf = std::mem::take(&mut self.buffer);
        let b = buf.as_bytes();
        let mut i = 0;
        while i < b.len() {
            let (len, hit) = match b[i] {
                b'\n' => (1, true),
                b'\r' if i + 1 < b.len() => (if b[i + 1] == b'\n' { 2 } else { 1 }, true),
                b'\r' if at_end => (1, true),
                _ => (0, false), // a lone \r at the very end may be half of \r\n: wait for the next read
            };
            if hit {
                let line = &buf[offset..i];
                out.extend(self.line(line));
                i += len;
                offset = i;
            } else {
                i += 1;
            }
        }
        let rest = &buf[offset..];
        if at_end && !rest.is_empty() {
            out.extend(self.line(rest));
        } else {
            self.buffer = rest.to_string();
        }
        out
    }

    fn line(&mut self, line: &str) -> Option<SseMessage> {
        if line.is_empty() {
            return self.flush();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.find(':') {
            Some(c) => (
                &line[..c],
                line[c + 1..].strip_prefix(' ').unwrap_or(&line[c + 1..]),
            ),
            None => (line, ""),
        };
        match field {
            "event" => {
                self.event = value.to_string();
            }
            "data" => {
                self.data.push(value.to_string());
            }
            _ => {}
        }
        None
    }

    fn flush(&mut self) -> Option<SseMessage> {
        if self.data.is_empty() && self.event.is_empty() {
            return None;
        }
        let event = if self.event.is_empty() {
            "message".to_string()
        } else {
            std::mem::take(&mut self.event)
        };
        let data = std::mem::take(&mut self.data).join("\n");
        Some(SseMessage { event, data })
    }
}

// ---- the stream becomes a model result -----------------------------------------------------------------------------

struct PendingCall {
    call_id: String,
    name: String,
    args: String,
}

/// `streamChat` + `collectStream`: Chat Completions chunks in, the parts of one assistant message out.
/// Calls are correlated by the delta's `index`, never by array position: a chunk may carry only the entry that changed.
#[derive(Default)]
pub struct ChatAccumulator {
    text: String,
    calls: Vec<(i64, PendingCall)>, // insertion order, as a JS Map keeps it
    finish: Option<String>,
    usage: Option<Value>,
    done: bool,
}

fn finish_from_chat(raw: &str) -> &'static str {
    match raw {
        "stop" => "stop",
        "length" => "length",
        "tool_calls" | "function_call" => "tool-calls",
        "content_filter" => "content-filter",
        _ => "unknown",
    }
}

fn usage_from_chat(u: &Value) -> Value {
    let mut out = Map::new();
    let mut put = |key: &str, v: &Value| {
        if !v.is_null() {
            out.insert(key.into(), v.clone());
        }
    };
    put("inputTokens", &u["prompt_tokens"]);
    put("outputTokens", &u["completion_tokens"]);
    put("totalTokens", &u["total_tokens"]);
    put(
        "cachedInputTokens",
        &u["prompt_tokens_details"]["cached_tokens"],
    );
    put(
        "reasoningTokens",
        &u["completion_tokens_details"]["reasoning_tokens"],
    );
    Value::Object(out)
}

impl ChatAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// True once `[DONE]` was seen: the rest of the body is not read.
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// One event's `data`. A frame that is not JSON is skipped, not fatal: the finish still arrives.
    pub fn push_data(&mut self, data: &str) {
        if self.done {
            return;
        }
        if data == "[DONE]" {
            self.done = true;
            return;
        }
        if data.is_empty() {
            return;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            return;
        };
        if chunk["usage"].is_object() {
            self.usage = Some(usage_from_chat(&chunk["usage"]));
        }
        let Some(choice) = chunk["choices"].get(0).filter(|c| !c.is_null()) else {
            return;
        };
        let delta = &choice["delta"];
        if let Some(t) = delta["content"].as_str() {
            self.text.push_str(t);
        }
        for call in delta["tool_calls"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            let index = call["index"].as_i64().unwrap_or(0);
            let pos = match self.calls.iter().position(|(i, _)| *i == index) {
                Some(p) => p,
                None => {
                    // The name starts EMPTY and is only accumulated below: seeding it from this fragment as well would
                    // write it twice for a server that sends the whole name up front.
                    self.calls.push((
                        index,
                        PendingCall {
                            call_id: format!("call_{index}"),
                            name: String::new(),
                            args: String::new(),
                        },
                    ));
                    self.calls.len() - 1
                }
            };
            let entry = &mut self.calls[pos].1;
            if let Some(id) = call["id"].as_str().filter(|s| !s.is_empty()) {
                entry.call_id = id.to_string();
            }
            if let Some(n) = call["function"]["name"].as_str() {
                entry.name.push_str(n);
            }
            if let Some(a) = call["function"]["arguments"].as_str() {
                entry.args.push_str(a);
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str().filter(|s| !s.is_empty()) {
            self.finish = Some(finish_from_chat(reason).to_string());
        }
    }

    /// The result: text first, then the calls in the order their first fragment arrived, arguments repaired.
    pub fn finish(self) -> ModelResult {
        let mut parts = vec![];
        if !self.text.is_empty() {
            parts.push(json!({"type": "text", "text": self.text}));
        }
        let had_calls = !self.calls.is_empty();
        for (_, c) in self.calls {
            let r = repair_tool_arguments(&Value::String(c.args));
            let mut p =
                json!({"type": "tool-call", "callId": c.call_id, "name": c.name, "input": r.value});
            if r.repaired {
                p["repaired"] = json!(true);
            }
            parts.push(p);
        }
        ModelResult {
            parts,
            finish_reason: self
                .finish
                .unwrap_or_else(|| if had_calls { "tool-calls" } else { "stop" }.to_string()),
            usage: self.usage.unwrap_or_else(|| json!({})),
        }
    }
}

// ---- errors ---------------------------------------------------------------------------------------------------------

/// `kindFromStatus`.
pub fn kind_from_status(status: u16) -> &'static str {
    match status {
        401 | 403 => "auth",
        429 => "rate-limit",
        408 => "timeout",
        400 | 404 | 422 => "invalid-request",
        s if s >= 500 => "overloaded",
        _ => "unknown",
    }
}

/// `/<a>.?<b>/i` over text already lowercased.
fn has_gap_pair(lower: &str, a: &str, b: &str) -> bool {
    let mut from = 0;
    while let Some(p) = lower[from..].find(a) {
        let after = &lower[from + p + a.len()..];
        if after.starts_with(b)
            || after
                .chars()
                .next()
                .is_some_and(|c| after[c.len_utf8()..].starts_with(b))
        {
            return true;
        }
        from += p + a.len();
    }
    false
}

/// `errorFromResponse`: the provider's own message out of the body, and the kind: from the status, refined by what the
/// message says.
pub fn error_from_response(
    provider: &str,
    status: u16,
    status_text: &str,
    body: &str,
) -> (String, String) {
    let mut message = format!("{provider} request failed with {status} {status_text}")
        .trim()
        .to_string();
    if !body.is_empty() {
        match serde_json::from_str::<Value>(body) {
            Ok(parsed) => {
                if let Some(m) = parsed["error"]["message"]
                    .as_str()
                    .filter(|m| !m.is_empty())
                {
                    message = m.to_string();
                }
            }
            Err(_) => message = take_utf16(body, 500),
        }
    }
    let lower = message.to_lowercase();
    let mut kind = kind_from_status(status);
    if kind == "invalid-request"
        && (has_gap_pair(&lower, "context", "length")
            || lower.contains("maximum context")
            || lower.contains("too many tokens")
            || lower.contains("reduce the length"))
    {
        kind = "context-length";
    }
    if has_gap_pair(&lower, "content", "filter")
        || lower.contains("content_policy")
        || lower.contains("safety")
    {
        kind = "content-filter";
    }
    (kind.to_string(), message)
}

// ---- the provider -----------------------------------------------------------------------------------------------------

/// What a transport answers with. `body` is read to its end, or until `[DONE]`.
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub body: Box<dyn Read + Send>,
}

#[derive(Debug, Clone)]
pub struct TransportError {
    /// `network`, `timeout` or `cancelled`.
    pub kind: String,
    pub message: String,
}

/// The seam where bytes leave the process. The provider never holds a credential: a transport knows where a request
/// goes and who signs it. `post_json` sends `body` as JSON to `path` (`/chat/completions`) and returns the response.
pub trait Transport: Send + Sync {
    fn post_json(&self, path: &str, body: &Value) -> Result<HttpResponse, TransportError>;
}

/// The Chat Completions provider over any transport.
pub struct OpenAiChat<T: Transport> {
    pub transport: T,
    pub model: String,
    /// Reported in an error's default message, like Super Chat's provider id.
    pub provider: String,
}

impl<T: Transport> OpenAiChat<T> {
    pub fn new(transport: T, model: impl Into<String>) -> Self {
        OpenAiChat {
            transport,
            model: model.into(),
            provider: "openai".into(),
        }
    }
}

impl<T: Transport> Model for OpenAiChat<T> {
    fn call(&self, req: &ModelRequest) -> Result<ModelResult, ModelFailure> {
        let body = build_request(
            &self.model,
            req.system.as_deref(),
            &req.messages,
            &req.tools,
        );
        let mut res = self
            .transport
            .post_json("/chat/completions", &body)
            .map_err(|e| ModelFailure {
                kind: e.kind,
                message: e.message,
                usage: None,
            })?;
        if !(200..300).contains(&res.status) {
            let mut text = String::new();
            // An unreadable body leaves the status alone to speak, as in Super Chat.
            let _ = res.body.read_to_string(&mut text);
            let (kind, message) =
                error_from_response(&self.provider, res.status, &res.status_text, &text);
            return Err(ModelFailure {
                kind,
                message,
                usage: None,
            });
        }
        let mut sse = SseDecoder::new();
        let mut acc = ChatAccumulator::new();
        let mut buf = [0u8; 8192];
        'read: loop {
            let n = match res.body.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    return Err(ModelFailure {
                        kind: "network".into(),
                        message: e.to_string(),
                        usage: None,
                    });
                }
            };
            for m in sse.push(&buf[..n]) {
                acc.push_data(&m.data);
                if acc.is_done() {
                    break 'read;
                }
            }
        }
        if !acc.is_done() {
            for m in sse.finish() {
                acc.push_data(&m.data);
            }
        }
        Ok(acc.finish())
    }
}
