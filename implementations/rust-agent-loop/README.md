# super-agent-loop

The agent loop of the Super libs as a **sans-IO state machine** in Rust, plus the tool-argument repair that runs before
it. Draft, **not published** (`publish = false`), not wired into any app. The rules are in
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

Everything crossing the boundary is `serde_json::Value`. One dependency (`serde_json`), no `unsafe`, no async runtime,
no network. MSRV 1.89.

```bash
cargo test        # the loop (31 cases) and repair (769 inputs, 15 names), from ../../conformance
cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

## What is here

| | |
| --- | --- |
| `src/machine.rs` | `LoopMachine`: steps, parallel tools, approvals, stop conditions, the repeated-call guard, checkpoint and resume (about 670 lines after rustfmt; the TypeScript machine is about 380) |
| `src/repair.rs` | `repair_tool_arguments`, `normalize_tool_name`: a port of Super Chat's `repair.ts`, quirks included (about 320 lines; the TypeScript is about 160) |
| `tests/conformance.rs` | runs both files; a case that needs a feature this crate does not have is skipped by name (none today) |

## What it does not have, and what that means for a go/no-go

This crate is the *decisions* of the loop. A loop that can run a turn also needs, and none of it is written:

- a **driver** (Tokio): calls the model, runs tools with timeouts and cancellation, waits for the person, persists
  `append` and `checkpoint`;
- **provider adapters** with streaming (the Router's OpenAI-compatible API, Anthropic, ...): SSE to `model-result`,
  partial tool-call JSON for previews, usage;
- a **tool registry** with argument validation against the tool's schema, `explainMissingInput`, skill unlock;
- an **MCP client** (Streamable HTTP, sessions, capability negotiation);
- **context building** (budgeting, compaction), background jobs, metering records, card production.

What the two conformance files show, and what they do not:

- *Shows:* the decision part of the loop and the repair function can be written as data of a size one person can
  read (a 200-line spec, 31 transcripts, 769 repair inputs), and a second implementation, in another language, can be
  held to it. The mutation checks matter: changing one rule in the Rust code (the trim set, the trailing-comma pass,
  the single-quote pass, the declined text, the resume-after-approval rule) fails the suite.
- *Found while porting:* JavaScript's `trim()` and `\s` strip U+FEFF and not U+0085, Rust's `trim()` the other way round
  (repair cases now pin both); JavaScript slices error text by UTF-16 units; integers beyond 2^53 are exact in Rust and
  rounded in JavaScript; `serde_json` refuses nesting beyond 128 levels. These are the places where a second implementation
  hurts, and each is now a case or a documented limit.
- *Does not show:* that the rest above is cheap, that the Rust loop is faster or safer in a way a user sees, or that
  it will stay in step with `runAgent` over time. The repeated-call guard and checkpoint/resume are specified here, not
  taken from a loop that ships: 21 of the 31 cases are also checked against the real `runAgent`; the 9 that need the guard or checkpoint, only against the
  hand-written expectations. Both machines were written by one author.
