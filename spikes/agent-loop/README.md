# Spike: a language-neutral agent loop with a conformance file

**Throwaway, 2026-11-24. Not published, not wired into anything, not part of `protocol.v1.json`.** It tests one
idea from the agent-harness review (`super-dev-docs`: `docs/60-reference/agent-harness-review-2026-11-24.md`):

> Describe the loop's *decisions* as a sans-IO state machine, pin them in a JSON file of transcripts, and let a
> Rust loop and Super Chat's TypeScript `runAgent` both be checked against that file.

Read [`SPEC.md`](SPEC.md) first (two pages). The cases are in [`cases/`](cases/).

## What is here

| Path | What |
| --- | --- |
| `SPEC.md` | The machine: inputs, effects, 11 rules, what v0 leaves out |
| `cases/cases.src.mjs`, `cases/agent-loop.v0.json` | 16 hand-written transcripts (`node cases/build.mjs` rebuilds the JSON) |
| `ts/machine.ts` | The spec as a TypeScript machine (about 300 lines, no dependencies) |
| `ts/invariants.ts` | The whole-stream rules of `docs/RUN-EVENTS.md` as code |
| `rust/` | The spec as a Rust machine (`serde_json` only) and a test that reads the same JSON |
| `real/` | The same cases replayed against Super Chat's **real** `runAgent` (needs a Super Chat checkout) |

## Run it

```bash
# 1. the TypeScript machine, and every fixture checked against the stream rules (Node 22, no install)
node --test ts/conformance.test.ts

# 2. the Rust machine, same JSON
(cd rust && cargo test)

# 3. Super Chat's real runAgent, same JSON (from inside a Super Chat checkout that has had `pnpm install`)
ln -sfn "$SUPER_CHAT_DIR/node_modules" real/node_modules      # git-ignored
(cd "$SUPER_CHAT_DIR" && SUPER_CHAT_DIR="$SUPER_CHAT_DIR" pnpm exec vitest run \
   --config "$OLDPWD/real/vitest.config.ts")
```

## Result (2026-11-24, super-chat@53c1df4, super-protocol@42fb430)

| Implementation | Cases | Result |
| --- | --- | --- |
| TypeScript machine (`ts/machine.ts`) | 16 | pass |
| Rust machine (`rust/src/lib.rs`) | 16 | pass |
| Super Chat's real `runAgent`, events only | 15 (the 16th, a refused input, is a property of the machine API) | pass, after two fixture fixes below |

Mutation check: changing one string in the Rust machine, or one `finishReason` in the TS machine, makes the
suite fail (1 of 16 cases, and 3 tests), so the tests do discriminate. Super Chat's tree was not modified.

**What this does and does not show.** It shows the decision part of the loop (steps, tool dispatch and result
order, confirm gating, stop conditions, errors, cancel, usage) can be written as data and that three
implementations agree on it. It does **not** show a Rust loop is cheap to build or complete: the machine here is
about 365 lines of Rust and covers v0 only (`SPEC.md` section 6 lists what it leaves out, which is most of
`runAgent`'s surface). Both machines were written by the same author who had just read `runAgent`, so agreement
between them is weaker evidence than agreement with the real code; the real-`runAgent` check is the one that
counts, and it compares events only.

## Findings from running the real `runAgent`

1. **`userDeclined` (and so `DEFAULT_STOP_CONDITIONS`) does not fire when the person declines a runtime
   approval.** The decline is turned into `{ error: "The user declined." }` with `failure: "denied"`;
   `output.cancelled === true`, which `userDeclined` looks for, only appears in the value handed to a tool that
   asks for itself (`confirmation: "tool"`). Case `confirm-tool-declined` pins the behaviour as it is: the run
   goes on to a second model call. The stop condition's comment ("proceeding would ignore them") says the
   opposite intent. Open question for Super Chat, not decided here.
2. **The loop writes English prose for the person** when it hits the step limit ("Reached the 8-step limit…").
   A Chinese or Japanese host cannot localise it. The spec emits a `notice` part instead; the real-run adapter maps
   the English text to it.
3. **The `error` event's payload is `unknown`, and nothing pins its wire shape.** A plain `JSON.stringify` of
   the TypeScript `AgentError` gives `{"name":"AgentError","kind":"overloaded"}`: the message is gone (checked in
   Node). The spec pins `{ kind, message }`; the adapter reads `kind` and `message` off the object.
4. **A thrown tool error always carries a `kind`** (`"unknown"` for a plain `Error`), because it goes through
   `toAgentError` then `compactError`. The first draft of two fixtures left it out; the real run caught that.
5. **`runAgent` exposes no effects.** What is appended to the history, and in which order, cannot be observed
   from outside except by capturing the next provider request. The machine makes it an explicit `append` effect
   (call order for tool results), which the real-run check therefore cannot verify.
6. **From reading, not exercised by a case:** a tool that times out is reported with `failure: "execution-error"`
   (`execute-tools.ts` passes `"timeout"` only to the missing-input hint, not to the outcome). Worth a case once
   the spec has a clock effect.

## What a real version would need (not done)

Move these cases next to `protocol.v1.json` and add `agent-loop` as one more thing the TypeScript package
generates; give `runAgent` a thin adapter over the machine so there is one source of truth; add the pieces in
`SPEC.md` section 6, starting with checkpoint/resume and the repeated-call guard; decide finding 1; decide
whether a Rust loop is worth a second implementation of everything outside the machine (provider adapters,
MCP client, argument repair), which this spike does not measure.
