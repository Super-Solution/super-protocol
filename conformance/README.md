# Conformance data

Language-neutral test data for `@supersolutions/super-protocol`. The TypeScript package in
[`../implementations/typescript`](../implementations/typescript) is the reference; every other implementation must reproduce these
cases exactly, error messages included.

| File | What it pins |
| --- | --- |
| `protocol.v1.json` | `plugin_manifest` (issue lists), `editor_card`, `chart_card` and `plot_card` (result objects), `terminal_event`, `run_event` (issue lists), `run_event_type` (whether a type is known and whether it ends a run), `run_stream_outcome` (what a stopped stream says about its run), `sse` (hex-encoded byte chunks, optional frame limit, expected frames or the error code), and `plot_fallback_message` (the text a user sees in place of a plot that cannot be drawn) |
| `agent-loop.v0.json` | transcripts of the agent loop: `(input, events, effects)` per step, 31 cases. Written by hand from [`docs/AGENT-LOOP.md`](../docs/AGENT-LOOP.md); `node scripts/export-agent-loop.mjs` builds it from `scripts/agent-loop/cases.mjs` |
| `agent-loop-replay.v0.json` | the **shadow replay**: 31 whole runs described by their wire bytes (the SSE body of every model call, what each tool does, what the person answers) with what Super Chat's real `runAgent` and OpenAI Chat Completions adapter did with them: the run's events and the exact body of every request. **Generated**: `SUPER_CHAT_DIR=... node scripts/export-agent-replay.mjs` |
| `tool-repair.v0.json` | what `repairToolArguments` and `normalizeToolName` return for 769 malformed model outputs. **Generated from Super Chat's `repair.ts`**: `SUPER_CHAT_DIR=... node scripts/export-tool-repair.mjs` |

The agent-loop files are run by `implementations/typescript/src/agent-loop` (the reference machine), `implementations/rust-agent-loop` and
Super Chat (`packages/core/src/conformance/`, copies). They are separate from `protocol.v1.json` on purpose: the loop is a draft and
nothing published depends on it.

Known limits of the data: URLs are realistic base URLs (no percent-encoded or internationalised
hosts), strings are valid UTF-8 (a multi-byte character may be split across SSE chunks), and string
lengths count UTF-16 code units, as JavaScript does.

```bash
pnpm build && pnpm conformance:export       # regenerate (from the repo root)
pnpm test                                    # TypeScript still matches
(cd implementations/go && go test ./...)                     # Go port
(cd implementations/python && pytest)                        # Python port
```

If behaviour changes on purpose, regenerate, review the diff, and update every port. A closed-source
Rust implementation, if one exists, lives in a private repository and tests against this same file.
