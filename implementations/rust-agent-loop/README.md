# super-agent-loop

The agent loop of the Super libs in Rust: a **sans-IO state machine**, the tool-argument repair that runs before it, and (since
the second gate) a driver, one provider and an HTTP transport. Draft, **not published** (`publish = false`), not wired into any app. The rules are in
[`docs/AGENT-LOOP.md`](../../docs/AGENT-LOOP.md); the contract is the two files in [`conformance/`](../../conformance)
that this crate's tests read.

```rust
use serde_json::json;
use super_agent_loop::LoopMachine;

let mut m = LoopMachine::new(&json!({ "tools": [{ "name": "echo", "side": "read" }] }));
let step = m.feed(&json!({ "kind": "start", "runId": "run_1", "mode": "stream", "messages": [] }))?;
// step.events: run-start, step-start      step.effects: call-model { step: 0, toolNames: ["echo"] }
// ... the driver calls the model, feeds back `model-result`, runs the tools it asked for, and so on.
```

Everything crossing the boundary is `serde_json::Value`. Default build: one dependency (`serde_json`, with `preserve_order`),
no `unsafe`, no async runtime, no network. The `http` feature adds `ureq` for a real socket. MSRV 1.89 (not checked
with the `http` feature: `ureq`'s TLS tree may need a newer compiler).

```bash
cargo test                    # the loop (31 cases), repair (769 inputs, 15 names), the shadow replay (31 runs)
cargo test --features http    # and the transport against a real local socket
cargo clippy --all-targets --features http -- -D warnings && cargo fmt --check
```

## What is here

| | |
| --- | --- |
| `src/machine.rs` | `LoopMachine`: steps, parallel tools, approvals, stop conditions, the repeated-call guard, checkpoint and resume (about 740 lines after rustfmt; the TypeScript machine is about 380) |
| `src/repair.rs` | `repair_tool_arguments`, `normalize_tool_name`: a port of Super Chat's `repair.ts`, quirks included (about 380 lines; the TypeScript is about 160) |
| `src/driver.rs` | `Driver`: runs a machine. Calls a `Model`, runs tools on scoped threads (results fed back in completion order), asks a `Person`, keeps the history, takes a cancel flag from another thread. Also the tool layer the model reads: a thrown error becomes a `failure` with a `kind`, a failed call with missing arguments is told which. Tools are declared to the model in `localeCompare` order (about 450 lines) |
| `src/openai_chat.rs` | `OpenAiChat<Transport>`: the OpenAI Chat Completions dialect, streaming. History to request body, a WHATWG SSE decoder (bytes in, any cut), tool-call fragments by index to repaired calls, usage, HTTP errors to a `kind` (about 640 lines; the TypeScript it ports is about 560) |
| `src/http.rs` | `HttpTransport` (feature `http`): bearer key and headers, `ureq`, the body read as it arrives |
| `tests/conformance.rs` | the 31 loop cases and the repair file; a case that needs a feature this crate does not have is skipped by name (none today) |
| `tests/replay.rs` | **the shadow replay**: 31 whole runs from wire bytes, events and request bodies compared with what Super Chat's real `runAgent` did |
| `tests/driver.rs`, `tests/provider_units.rs`, `tests/http.rs` | what the replay cannot say: cancel from another thread, a panicking tool, nobody to ask; every cut of a multi-byte SSE frame; a real socket |

```rust
use std::sync::atomic::AtomicBool;
use super_agent_loop::{Driver, HttpTransport, OpenAiChat, RunSpec};

let model = OpenAiChat::new(HttpTransport::new("https://router.example/v1").with_api_key(key), "model-id");
let driver = Driver { model: &model, tools: &my_tools, person: Some(&my_person), spec: RunSpec { /* run_id, system, tools */ ..Default::default() } };
let out = driver.run(history, &AtomicBool::new(false))?;   // out.events: RunEvents; out.history: what the model saw
```

## What the replay found

Writing the driver and provider against the TypeScript loop's behaviour, the replay failed first on things nobody had
written down: tools are declared in ICU `localeCompare` order, not byte order; request bodies are `JSON.stringify`'s bytes, so
`serde_json` needs `preserve_order` and a tool result in history is its output as that string (or the string itself);
a thrown tool error carries a `kind` read from its words; a router-prefixed tool name is *not* resolved by the loop. All
five are scenarios now and are listed in `docs/AGENT-LOOP.md` section 10. Sixteen deliberate mutations of the Rust provider
and driver (SSE leading-space rule, fragment correlation by position instead of `index`, orphan-call dropping, the
context-length and content-filter error refinements, text placement, `stream_options`, usage details, tool order,
byte-order sorting, missing-argument hints, error kinds from words, string-output stringification, the one-text-part
user shortcut, `[DONE]`) each fail the replay. One scenario was flaky until two tools with the same delay were given
different ones: completion order is part of what is compared.

## What it still does not have

- **Retries** with back-off and `Retry-After` (Super Chat retries 429/5xx/network three times by default; this provider
  reports the first failure). **Anthropic** and the **Responses** dialect. **Images, files, audio**, `reasoning_content`,
  provider-native tools: ignored, not translated.
- **Context building** (budgeting, compaction, memory, skills), a **tool registry** with schema validation of arguments
  and skill unlock, an **MCP client**, background jobs, metering records, card production by tools, `tool-call-input-delta`
  previews, text deltas as they arrive (the driver reports a step's text when the step's stream has ended).
- A **persistence** layer for `append` and `checkpoint` (the driver keeps history in memory and never asks for a
  snapshot), and an **async** driver. Threads and blocking reads are fine for a worker; a server that holds thousands of runs
  would want Tokio around the same machine.
- The `http` feature is checked against a local server, not against OpenAI, a Super Router or a real TLS endpoint.

## What this shows for a go/no-go

- *Shows:* a second implementation of the loop *and its provider seam* can be held to the first by data that the first
  produced, not by the second's author. 31 runs and about 1,100 lines of Rust (driver, provider, transport) were enough to find five
  behaviours that no document had. Size is **not** a result here: the TypeScript it ports (`run.ts`, `execute-tools.ts`,
  `stream.ts`, `sse.ts`, the chat half of `map-in.ts`) does more than this crate does (retries, reasoning, images,
  previews, the Responses dialect), so the Rust being no larger says nothing about the cost of parity.
- *Found while porting the repair:* JavaScript's `trim()` and `\s` strip U+FEFF and not U+0085, Rust's `trim()` the other
  way round (repair cases pin both); JavaScript slices error text by UTF-16 units; integers beyond 2^53 are exact in Rust and
  rounded in JavaScript; `serde_json` refuses nesting beyond 128 levels.
- *Does not show:* that the rest is cheap (retries, Anthropic, context building, the registry and MCP are most of
  `runAgent`'s weight), that the Rust loop is faster or safer in a way a user sees (nothing was measured), or that it
  stays in step with `runAgent` over time (`export-agent-replay.mjs --check` is the guard and runs only when someone
  has a Super Chat checkout). The repeated-call guard and checkpoint/resume are specified here, not taken from a loop that
  ships: 21 of the 31 cases are also checked against the real `runAgent`; the 9 that need the guard or checkpoint only
  against hand-written expectations. The machine and the Rust code around it were written by one author.
