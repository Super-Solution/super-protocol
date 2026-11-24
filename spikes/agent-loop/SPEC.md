# Agent loop, v0 (spike)

**Status: spike, 2026-11-24.** A language-neutral description of what one agent turn *decides*, plus a file of
transcripts (`cases/agent-loop.v0.json`) that any implementation can be run against. It is not part of
`protocol.v1.json`, not published, and its shapes may change. It exists to answer one question: can the loop's
behaviour be pinned down in data, so a Rust loop and Super Chat's TypeScript `runAgent` can be shown to agree?

(Answer after this spike: yes, for the decision part of the loop. See "What it shows" in `README.md` and the
design memo in super-dev-docs, `docs/60-reference/agent-harness-review-2026-11-24.md`.)

## 1. The idea: the loop is a pure function of what it is told

`runAgent` mixes three things: deciding what happens next, talking to the world (model, tools, the person, the
clock), and reporting. This spec keeps only the first. The loop is a **machine**:

```
feed(input) -> { events: RunEvent[], effects: Effect[] }
```

- It never calls a model, runs a tool, reads a clock, makes an id or waits. Those are **effects** it asks a
  **driver** to do. The driver feeds back what happened as the next **input**.
- It reports with the same `RunEvent`s as `docs/RUN-EVENTS.md`.
- Because nothing is async and nothing is time, a test is a list of `(input, events, effects)`. No mocks, no
  sleeps, no network, no model key.

The driver is where languages differ (Tokio, a JS event loop, a queue worker). The machine is where they must agree.

## 2. Inputs (driver to machine)

| `kind` | Fields | Legal when |
| --- | --- | --- |
| `start` | `runId`, `mode`, `messages` | first, once |
| `model-result` | `parts[]` (`text`, `tool-call`), `finishReason`, `usage` | a `call-model` is outstanding |
| `model-error` | `error: { kind, message }`, `usage?` | a `call-model` is outstanding |
| `tool-outcome` | `callId`, `output`, `failure?`, `ms` | that call has a `run-tool` outstanding |
| `user-action` | `callId`, `action: { type, value? }` | that call has an `ask-user` outstanding |
| `cancel` | none | during a run |

Any other input is **refused** (an error, no events, no change of state). A refused input is a bug in the
driver, never something to guess around.

## 3. Effects (machine to driver)

| `kind` | Means |
| --- | --- |
| `call-model` `{ step, toolNames }` | Ask the model. `toolNames` is the tool set the model may call this step. |
| `run-tool` `{ callId, name, input }` | Run this tool; answer with `tool-outcome`. Several may be outstanding at once. |
| `ask-user` `{ callId }` | The person must answer the approval card just announced; answer with `user-action`. |
| `append` `{ message }` | Write this message to the history, in this order. (`assistant`, or `tool` with results in **call order**.) |
| `done` | Nothing more will happen. |

## 4. Rules

1. **Steps.** `maxSteps` defaults to 8. A step is one model call. Before each step the machine checks `cancel`:
   a cancelled run ends as `error{cancelled}` then `run-finish{cancelled}` and no `step-start` is sent. The check
   is not made once `maxSteps` is reached.
2. **A model result with no tool call ends the run** with that result's `finishReason`.
3. **Events of a model result, in this order:** one `text-delta` per text part, `usage`, `step-finish`, then one
   `tool-call` per call (call order). `usage` is always sent, `{}` if the model reported none.
4. **Tools.** A call to a name that is not in `config.tools` is answered by the machine itself, at once, as
   `failure: "not-found"` with `output.availableTools`. Every other call that is not `side: "confirm"` becomes a
   `run-tool` effect, all together. `tool-result` events go out **in completion order**; the `append` of the step
   keeps **call order**. All results of a step arrive before the next `step-start`.
5. **Confirm tools** run one at a time, after every other call of the step has settled. With `interactive: true`
   the machine sends `awaiting-user` and `ask-user`; on `user-action` it sends `user-responded`. The tool runs
   only if the action is not `cancel`/`dismiss` and its `value` is absent or `{ confirmed: true }`; otherwise
   the result is `failure: "denied"`, `{ error: "The user declined." }`. With `interactive: false` there is no
   card: the result is `failure: "denied"` at once and the tool never runs.
6. **A tool that failed is a result, not an error.** The run goes on; the model sees the `failure`.
7. **Stop conditions** are data: `stepCountIs`, `afterTool`, `tokenBudgetExceeded`, `consecutiveFailures`,
   `userDeclined`. They are checked after the tools of a step, in order, and the first true one ends the run
   with `finishReason: "stop"`. `consecutiveFailures` keeps a streak that only moves when it is reached.
   `userDeclined` looks for `output.cancelled === true` (see finding 1).
8. **Limit.** If the run ends because `maxSteps` was reached while the last step still called tools, a
   `message` event with a `notice` part `{ code: "step-limit", steps }` goes out before `run-finish`. The loop
   never writes prose for the person; the host words the notice.
9. **Usage** is added up per field (a field nobody reported stays absent). `run-finish.usage` is that sum and
   `run-finish.steps` counts attempted steps, including one that failed.
10. **Failure.** `model-error` sends the partial `usage` if it has any, then `error{ error: { kind, message },
    recoverable: false }`, then `run-finish` with `error`, or `cancelled` when `kind` is `cancelled`.
11. **Only `run-finish` ends a run.** After it the machine refuses everything.

## 5. Case file

`cases/agent-loop.v0.json` is built from `cases/cases.src.mjs` (`node cases/build.mjs`). The source is written by
hand, so the expected events are what this spec says, not what an implementation printed. A case:

```
{ name, description, config: { maxSteps?, stopWhen?, interactive?, tools: [{ name, side }] },
  steps: [ { in: <input>, events: [...], effects: [...] } | { in: <input>, reject: true } ] }
```

An implementation passes when, for every step, `feed(in)` returns exactly `events` and `effects` (deep equality,
order included) or, for `reject`, is refused.

## 6. Not covered by v0 (on purpose)

Deltas of arbitrary size and `reasoning-delta`; `tool-call-input-delta` previews; background mode (`job-*`);
`metering` records (prices and clocks belong to the host); `context-built`; card production by tools (`card`,
`card-updated`); skills that unlock tools mid-run; argument repair; `explainMissingInput`; per-tool timeouts;
the history *content* beyond the two messages above (card stripping); resuming from a checkpoint; sub-agents;
the repeated-call guard that Lawsis wants. Each is a later, separate piece, and several belong to the tool or
driver layer rather than the machine.
