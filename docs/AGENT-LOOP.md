# Agent loop (v0)

**Status: draft, 2026-11-25.** A language-neutral description of what one agent turn *decides*, and two files of
transcripts that any implementation can be run against: `conformance/agent-loop.v0.json` (the loop) and
`conformance/tool-repair.v0.json` (what to do with malformed tool arguments). Not published: the TypeScript machine
is not exported from `@supersolutions/super-protocol`, the Rust crate has `publish = false`, and the shapes may
still change. Nothing in `protocol.v1.json` depends on this page.

It exists so that Super Chat's TypeScript `runAgent` and a Rust loop can be shown to agree (section 10 shows it on whole runs, not only on decisions), and so that a person
who reads only the Rust or only the TypeScript knows what the other one must do.

| Path | What |
| --- | --- |
| `docs/AGENT-LOOP.md` | this page: inputs, effects, rules |
| `scripts/agent-loop/cases.mjs`, `conformance/agent-loop.v0.json` | the transcripts: written by hand; `node scripts/export-agent-loop.mjs` builds the JSON, `--check` verifies it |
| `scripts/export-tool-repair.mjs`, `conformance/tool-repair.v0.json` | the repair cases: generated from Super Chat's `repair.ts` (`SUPER_CHAT_DIR=... node scripts/export-tool-repair.mjs`) |
| `implementations/typescript/src/agent-loop/` | the TypeScript reference machine and the whole-stream rules of [RUN-EVENTS](RUN-EVENTS.md) as code |
| `implementations/rust-agent-loop/` | the Rust crate `super-agent-loop`: the machine, the repair port, a driver, one provider (OpenAI Chat Completions) and an HTTP transport |
| `scripts/agent-loop/replay-scenarios.mjs`, `scripts/export-agent-replay.mjs`, `conformance/agent-loop-replay.v0.json` | the shadow replay (section 10): whole runs from wire bytes, with what Super Chat's `runAgent` did with them. Generated: `SUPER_CHAT_DIR=... node scripts/export-agent-replay.mjs` |
| Super Chat `packages/core/src/conformance/` | copies of both files, run against the real `runAgent` (events only) |

## 1. The loop is a pure function of what it is told

`runAgent` mixes three things: deciding what happens next, talking to the world (model, tools, the person, the
clock), and reporting. This spec keeps only the first. The loop is a **machine**:

```
feed(input) -> { events: RunEvent[], effects: Effect[] }
```

- It never calls a model, runs a tool, reads a clock, makes an id or waits. Those are **effects** it asks a
  **driver** to do. The driver feeds back what happened as the next **input**.
- It reports with the same `RunEvent`s as [RUN-EVENTS](RUN-EVENTS.md).
- Nothing is async and nothing is time, so a test is a list of `(input, events, effects)`: no mocks, sleeps,
  network or key.

The driver is where languages differ (Tokio, a JS event loop, a queue worker). The machine is where they must agree.

## 2. Inputs (driver to machine)

| `kind` | Fields | Legal when |
| --- | --- | --- |
| `start` | `runId`, `mode`, `messages` | first, once |
| `model-result` | `parts[]` (`text`, `tool-call` with an optional `repaired: true`), `finishReason`, `usage` | a `call-model` is outstanding |
| `model-error` | `error: { kind, message }`, `usage?` | a `call-model` is outstanding |
| `tool-outcome` | `callId`, `output`, `failure?`, `ms` | that call has a `run-tool` outstanding |
| `user-action` | `callId`, `action: { type, value? }` | that call has an `ask-user` outstanding |
| `cancel` | none | during a run |
| `snapshot` | none | a model call, a tool or an approval is outstanding (feature `checkpoint`) |
| `resume` | `state` | first, instead of `start`, on a new machine (feature `checkpoint`) |

Any other input is **refused** (an error whose text starts `illegal-input`, no events, no change of state). A
refused input is a bug in the driver, never something to guess around.

## 3. Effects (machine to driver)

| `kind` | Means |
| --- | --- |
| `call-model` `{ step, toolNames }` | Ask the model. `toolNames` is the tool set the model may call this step. |
| `run-tool` `{ callId, name, input }` | Run this tool; answer with `tool-outcome`. Several may be outstanding at once. |
| `ask-user` `{ callId }` | The person must answer the approval card just announced; answer with `user-action`. |
| `append` `{ message }` | Write this message to the history, in this order. (`assistant`, or `tool` with results in **call order**.) |
| `checkpoint` `{ state }` | The answer to `snapshot`: what a new process needs to carry on (section 6). |
| `done` | Nothing more will happen. |

## 4. Rules

1. **Steps.** `maxSteps` defaults to 8. A step is one model call. Before each step the machine checks `cancel`:
   a cancelled run ends as `error{cancelled}` then `run-finish{cancelled}` and no `step-start` is sent. The check
   is not made once `maxSteps` is reached.
2. **A model result with no tool call ends the run** with that result's `finishReason`.
3. **Events of a model result, in this order:** one `text-delta` per text part, `usage`, `step-finish`, then one
   `tool-call` per call (call order; `repaired: true` is repeated from the part when the part has it). `usage`
   is always sent, `{}` if the model reported none.
4. **Tools.** A call to a name that is not in `config.tools` is answered by the machine itself, at once, as
   `failure: "not-found"` with `output.availableTools`. Every other call that is not `side: "confirm"` becomes a
   `run-tool` effect, all together. `tool-result` events go out **in completion order**; the `append` of the step
   keeps **call order**. All results of a step arrive before the next `step-start`.
5. **Confirm tools** run one at a time, after every other call of the step has settled. With `interactive: true`
   the machine sends `awaiting-user` and `ask-user`; on `user-action` it sends `user-responded`. The tool runs
   only if the action is not `cancel`/`dismiss` and its `value` is absent or `{ confirmed: true }`; otherwise
   the result is `failure: "denied"`, `{ error: "The user declined." }`. With `interactive: false` there is no
   card: the result is `failure: "denied"` at once and the tool never runs.
6. **A tool that failed is a result, not an error.** The run goes on; the model sees the `failure`. **So is a
   person's no:** the model reads "The user declined." and the run goes on, unless the host adds `userDeclined`.
7. **Stop conditions** are data: `stepCountIs`, `afterTool`, `tokenBudgetExceeded`, `consecutiveFailures`,
   `userDeclined`. They are checked after the tools of a step, in order, and the first true one ends the run
   with `finishReason: "stop"`. `consecutiveFailures` keeps a streak that only moves when it is reached.
   `userDeclined` is true when an outcome is the person saying no, in one of three shapes: `failure: "denied"`
   with `output.error` equal to the declined text of rule 5; `output.cancelled === true` (a tool that asks for
   itself and returns the answer it got); or `output.response.cancelled === true` (a declined interactive
   card). A tool's own `denied` and a host that cannot ask are not the person saying no. No stop condition is on
   unless the host puts it in `stopWhen`.
8. **Limit.** If the run ends because `maxSteps` was reached while the last step still called tools, a
   `message` event with a `notice` part `{ code: "step-limit", steps }` goes out before `run-finish`. The loop
   never writes prose for the person; the host words the notice.
9. **Usage** is added up per field (a field nobody reported stays absent). `run-finish.usage` is that sum and
   `run-finish.steps` counts attempted steps, including one that failed.
10. **Failure.** `model-error` sends the partial `usage` if it has any, then `error{ error: { kind, message },
    recoverable: false }`, then `run-finish` with `error`, or `cancelled` when `kind` is `cancelled`.
11. **Only `run-finish` ends a run.** After it the machine refuses everything.
12. **Repeated-call guard** (feature `repeat-guard`, config `repeatGuard: true`, off by default). In call order, a
    call to a known tool whose name and input equal a call already made earlier in the run (this step included) is
    not run and not asked about. It is answered at once, like an unknown tool, as `failure: "denied"` with
    `{ error: "Repeated call: \"<name>\" was already called with the same input in this run. Use that result or
    change the arguments." }`. A call counts as made whatever came of it: it failed, or the person declined it.
    Inputs are equal as JSON values: object key order does not matter and numbers compare by value. Unknown
    tools are never compared.

## 5. Checkpoint and resume (feature `checkpoint`)

A run is long and a process dies. The machine can say what a new process needs, and a new machine can pick it up.

- `snapshot` answers with one `checkpoint` effect and nothing else; it changes nothing.
- `resume { state }` is the first input of a new machine. It restores the state and **re-issues whatever the
  snapshot was waiting for**, and only that:
  - waiting for the model: one `call-model` for the same step (the model is asked again; the step counts once);
  - waiting for tools: one `run-tool` for each call with no recorded result, **with the same `callId`** (a tool
    can use it as an idempotency key; tools run at least once), and no event: their `tool-call` events were
    already reported. Calls with a recorded result are not run again. A confirm call that was already approved is
    run again **without asking again**. If nothing is left to run, the machine goes on as usual;
  - waiting for the person: `awaiting-user` again, for a follower that was not there, and `ask-user`.
- A state the machine does not know (`v` is not 0, an unknown `phase`) is refused and changes nothing.
- The cancel flag is not part of the state. A cancel belongs to the driver, which sends `cancel` again if it wants.
- The `config` is not part of the state either: the new machine is built with the same one.

**The state** (`v: 0`), JSON, the same in every implementation:

```
{ v, runId, mode, step, attempted, usage, streaks: [n, ...], seen: [{ name, input }, ...],
  phase: "model" | "tools" | "ask",
  // tools and ask only:
  stepFinish, calls: [{ callId, name, input }], results: [{ callId, name, output, failure?, ms }] (in the order they settled),
  approved: [callId, ...], asking?: callId }
```

`streaks` is one number per stop condition (the `consecutiveFailures` streak; 0 for the others). `seen` is what the
repeat guard remembers; it is empty when the guard is off. `approved` lists confirm calls the person said yes to
that have not reported back. `asking` is present in phase `ask` only.

**What the driver must do** (not enforced by the machine): persist each `append` effect and the machine's
`checkpoint` together, so that a snapshot never describes a history the store does not have; take a snapshot after
every input it feeds (it is cheap) when it wants to lose at most that input; and treat a tool as at-least-once. If
the process dies between an input and its snapshot, that input is gone and its effect is issued again after
`resume`: a model that was already answered is asked again, and costs money. This is the same contract as
ADK's and the OpenAI Agents SDK's resume, and the same reason tools must be idempotent.

## 6. Tool-argument repair

Models emit malformed tool arguments (markdown fences, a raw newline inside a string, trailing commas, Python
literals, single quotes, prose around the object, double-encoded JSON) often enough that a turn must not die on
it. Repair is a **pure function of the raw text** that a driver runs *before* it feeds the machine; the machine
only repeats the resulting `repaired: true` flag (rule 3). It is pinned separately, in
`conformance/tool-repair.v0.json`:

```
repair:         [ { input: <raw argument, any JSON value>, expect: { value, repaired, error? } } ]
normalize_name: [ { input: <tool name>, expect: <name without a router's prefix> } ]
```

The reference is Super Chat's `repairToolArguments` and `normalizeToolName`; the order of the fixes and the quirks
of each are part of the contract (the file is generated from that code, and Super Chat's test fails when the code
and the file disagree). Known limits of the data: integers beyond 2^53 are avoided (JavaScript rounds them),
strings are valid Unicode, and an error message never cuts a surrogate pair.

## 7. The case file

`conformance/agent-loop.v0.json` is built from `scripts/agent-loop/cases.mjs`. The source is written by hand, so the
expected events are what this page says, not what an implementation printed. A case:

```
{ name, description, requires?: ["repeat-guard" | "checkpoint"],
  config: { maxSteps?, stopWhen?, interactive?, repeatGuard?, tools: [{ name, side }] },
  steps: [ { in: <input>, events: [...], effects: [...], fresh?: true } | { in: <input>, reject: true } ] }
```

An implementation passes a step when `feed(in)` returns exactly `events` and `effects` (deep equality, order
included) or, for `reject`, refuses it. `fresh: true` means the process died: build a new machine from the case's
`config`, then feed this step. An implementation that lacks a feature in `requires` skips the case **by name**; it
does not drop it. Super Chat's `runAgent` has neither feature (it exposes no effects and keeps no checkpoint), so it
runs the other cases and compares events only.

## 8. Not covered

Deltas of arbitrary size and `reasoning-delta`; `tool-call-input-delta` previews and partial-JSON parsing;
background mode (`job-*`); `metering` records (prices and clocks belong to the host); `context-built`; card
production by tools (`card`, `card-updated`); skills that unlock tools mid-run; per-tool
timeouts; the history *content* beyond the two messages above (card stripping, compaction); sub-agents; the MCP
client; every provider but OpenAI Chat Completions (section 10). Each is a later, separate piece, and several belong to the tool or driver layer rather
than the machine. The README of `implementations/rust-agent-loop` lists what a Rust loop would still have to build around the machine,
and `docs/60-reference/agent-harness-review-2026-11-24.md` in super-dev-docs carries the go/no-go.

## 9. Changing it

Change the cases first (`scripts/agent-loop/cases.mjs`), regenerate (`node scripts/export-agent-loop.mjs`), review the
JSON diff, then make every implementation pass: the TypeScript machine, the Rust crate, and Super Chat's copy of
the file (copy it over; its tests fail until `runAgent` agrees or the change is dropped). `scripts/check-all.sh`
runs the first three and checks the file is reproducible.

## 10. Shadow replay: the machine is not where a loop goes wrong

The cases of section 7 feed the machine what a driver would have fed it. Most of what breaks in a real agent loop is not
there: it is in how bytes become a model result (SSE framing, tool-call fragments that interleave by index), how a history
becomes a request, how an HTTP failure is read, what a tool's failure looks like to the model. A second implementation can
pass every case above and still disagree with the first on all of that.

`conformance/agent-loop-replay.v0.json` pins it on whole runs. A **scenario** scripts only the outside world, by hand:
the bytes of each model call (an SSE body cut where the scenario cuts it, or an HTTP error), what each tool does and how
long it takes, what the person answers. Then Super Chat's real `runAgent`, with its real OpenAI Chat Completions adapter, is
run over it, and what it did is written next to the scenario: `expected.events` (the run's events) and `expected.requests`
(the path and exact JSON body of every request it sent, key order included). So no expected value is typed by the author of
the other implementation. An implementation passes a scenario when the same bytes give the same events and the same
request bodies, byte for byte.

- Normalised before comparing: `context-built`, `metering` and `tool-call-input-delta` events are dropped (host and UI
  concerns); `runId` is fixed; `tool-result.ms` is compared as present, not as a number; adjacent `text-delta`s are joined
  (the loop reports a text part, a UI may see it in pieces); the step-limit message is its `notice` part.
- 31 scenarios: text, one and several tool calls (fragments interleaved by index, name and id on later fragments, no id, text
  before calls), repaired and unrepairable arguments, an unknown tool, a router-prefixed tool name, thrown errors read as
  `timeout`/`network`, tool output in odd key order and as a plain string, the three approval outcomes, the step limit,
  `afterTool`, usage with cached and reasoning tokens, a stream with no finish reason, frames after `[DONE]`, SSE framing
  (CRLF, comments, multi-line `data:`, malformed frame, frames cut mid-line, a character cut between reads), HTTP 401, 429
  (text body), 400 (context length, content filter) and 500 on the second step, a history with earlier turns and an
  unanswered call, and tools registered out of order.
- Not in it: images, files, audio, reasoning content, provider-native tools, the Responses dialect, Anthropic, retries
  and their back-off, cancellation (a signal is a driver matter, tested in the crate), background jobs.

Differences between the two loops that only this found (each is now a scenario):

1. Tools are declared to the model in **`localeCompare` order**, not byte order (`_` before digits before letters, `a`
   before `B`). A host that sorts by bytes sends a different prefix and never hits the provider's prompt cache.
2. A request body is **JSON.stringify's bytes**, so key order is part of the contract (`serde_json` needs
   `preserve_order`); a tool result in history is that string, or the output itself when it is a string.
3. A tool that throws is not `{ error }`: it carries a `kind` read from its words (`timeout`, `network`, `unknown`), and a
   failed call that left out required arguments also carries `missing` and `expected`. The model reads these.
4. A router-prefixed name (`default_api:echo`) is **not** resolved by the loop: the call is `not-found`. `normalizeToolName`
   is for hosts that choose to use it before the call.
5. A call with no `id` is named `call_<index>`; the name may arrive in pieces; only the first fragment of an index may carry
   the id.

What the replay does not make equal: floating-point text beyond what both print the same (`1e21`), and the byte order of
object keys in a *tool's own* output when a host builds it from an unordered map.
