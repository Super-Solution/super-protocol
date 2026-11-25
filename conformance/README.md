# Conformance data

Language-neutral test data for `@supersolutions/super-protocol`. The TypeScript package in
[`../implementations/typescript`](../implementations/typescript) is the reference; every other implementation must reproduce these
cases exactly, error messages included.

[`index.json`](index.json) lists every file here with its status, its sections, the number of cases in each and a sha256.
It is generated (`node scripts/export-index.mjs`, checked by the gate): read case counts there, not in prose.

| File | What it pins |
| --- | --- |
| `protocol.v1.json` | Sections, each a list of `{ value or input, expect }` cases. Every issue is `{ path, code, message, hint? }` (see [`docs/ISSUES.md`](../docs/ISSUES.md)); `issue_codes` is the closed set of codes and `did_you_mean` the hint of an `enum` issue. `plugin_manifest` (issue lists), `editor_card`, `chart_card` and `plot_card` (`{ ok, error, expected?, issues }`), `card_ref_parse`, `card_ref_format` and `chart_ref` (the `ref:` link, see [`docs/CARD-REFS.md`](../docs/CARD-REFS.md)), `card_placement` (whether a value is a placement and whether a kind may be shown there), `host_theme` (what `readHostTheme` keeps and the `--super-*` variables made of it), `tool_authority` (a tool's declared authority and the presets that grant it), `chat_plugin` (`validateChatPlugin` on the data of a plugin: its manifest, the card kinds and mounts it has, its tools; plus the card kinds it declares for the side panel), `inference_message`, `inference_request` and `stream_event` (issue lists for what a gateway accepts and streams back), `inference_stream_outcome` (what a stopped gateway stream says about its request), `terminal_event`, `run_event` (issue lists), `run_event_type` (whether a type is known and whether it ends a run), `run_stream_outcome` (what a stopped stream says about its run), `sse` (hex-encoded byte chunks, optional frame limit, expected frames or the error code), and the constant `plot_fallback_message` (the text a user sees in place of a plot that cannot be drawn) |
| `agent-loop.v0.json` | transcripts of the agent loop: `(input, events, effects)` per step. Written by hand from [`docs/AGENT-LOOP.md`](../docs/AGENT-LOOP.md); `node scripts/export-agent-loop.mjs` builds it from `scripts/agent-loop/cases.mjs` |
| `agent-loop-replay.v0.json` | the **shadow replay**: whole runs described by their wire bytes (the SSE body of every model call, what each tool does, what the person answers) with what Super Chat's real `runAgent` and OpenAI Chat Completions adapter did with them: the run's events and the exact body of every request. **Generated**: `SUPER_CHAT_DIR=... node scripts/export-agent-replay.mjs` |
| `tool-repair.v0.json` | what `repairToolArguments` and `normalizeToolName` return for malformed model outputs. **Generated from Super Chat's `repair.ts`**: `SUPER_CHAT_DIR=... node scripts/export-tool-repair.mjs` |

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
