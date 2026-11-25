# Interop with AG-UI, the AI SDK, MCP and OpenTelemetry (draft)

> **Draft.** These modules are not stable and can change in any release. The golden files are `*.v0.json`, outside
> `protocol.v1.json`, and nothing here is part of the wire contract.

A run (see [`RUN-EVENTS.md`](RUN-EVENTS.md)) is a list of events. Two other protocols carry the same thing, and a host
that already speaks one of them should not need a second client to show a run:

| Module | Other side | Golden file |
| --- | --- | --- |
| `@supersolutions/super-protocol/interop/ag-ui` | [AG-UI](https://docs.ag-ui.com) events | `conformance/interop-ag-ui.v0.json` |
| `@supersolutions/super-protocol/interop/ai-sdk` | the Vercel AI SDK UI message stream (`useChat`) | `conformance/interop-ai-sdk.v0.json` |
| `@supersolutions/super-protocol/interop/mcp` | MCP tool annotations, MCP Apps host context, elicitation actions | `conformance/interop-mcp.v0.json` |
| `@supersolutions/super-protocol/interop/otel` | OpenTelemetry GenAI span attributes | `conformance/interop-otel.v0.json` |

The first two are stream adapters; the last two are pure functions (no state, no stream) and are described after them.

All four are TypeScript only. They are not ported to Go or Python: a draft adapter that is wrong in three languages is worse
than one that is wrong in one, and the golden files already say what a port has to do.

## How the stream adapters work

Each of the first two modules has the same shape, so the next adapter looks like the last:

```ts
import { createEncoder, createDecoder, encode, decode } from "@supersolutions/super-protocol/interop/ag-ui";

const out = encode(runEvents, { onLoss: (loss) => console.warn(loss) }); // whole list
const machine = createEncoder();                                         // or one event at a time
for await (const event of source) send(machine.push(event));
send(machine.end());                                                      // the stream stopped: close what is open
```

- A machine has `push(input)` (one input, any number of outputs) and `end()`. There is no I/O and no timer.
- No runtime dependency. The chunk types are structural, so a host passes its own `ai` or `@ag-ui/core` values in and out
  unchanged. `ai`, `@ag-ui/core` and `zod` are devDependencies, used only by the generators and the tests.
- `onLoss({ type, field?, reason })` is called once for every event or field that has no place on the other side. Nothing is
  dropped without it being reported when the caller asks to hear.
- A stream that stops while a card waits for an answer means the run is **suspended**, not finished (as in
  `RUN-EVENTS.md`). Both encoders turn that into the other protocol's own wording; both decoders turn it back.

Every message in a golden file is checked, when the file is generated, against the real package: AG-UI events must parse
with the `@ag-ui/core` schemas without a field being dropped and must be in the order AG-UI asks for; UI message chunks
must pass `uiMessageChunkSchema` and are fed to `readUIMessageStream`, whose result is written next to them (`ui_message`).
`scripts/check-all.sh` re-generates both files and fails on a difference. The decode inputs that are not made by the
encoder are partly written by hand (`@ag-ui/core` has no generator of events); the `*-from-streamText` cases of the AI SDK
are made by the SDK itself, with a mock model.

## Run events to AG-UI (table A)

| Run event | AG-UI |
| --- | --- |
| `run-start` | `RUN_STARTED` (`threadId` from the event, the option, or the run id) |
| `step-start` / `step-finish` | `STEP_STARTED` / `STEP_FINISHED`, `stepName` is the step number as text |
| `text-delta` | `TEXT_MESSAGE_START` at the first delta, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` at the step's end |
| `reasoning-delta` | `REASONING_START`, `REASONING_MESSAGE_CONTENT`, `REASONING_END` |
| `tool-call` | `TOOL_CALL_START`, `TOOL_CALL_ARGS` (the input as JSON text), `TOOL_CALL_END` |
| `tool-result` | `TOOL_CALL_RESULT`; a failure is sent as `CUSTOM super.tool-failure` just before it |
| `card`, `card-updated` | `ACTIVITY_SNAPSHOT`, `activityType: "super-card"`, content is the card |
| `awaiting-user` | the card as above, then `RUN_FINISHED` with `outcome: { type: "interrupt", interrupts }` when the stream ends |
| `run-snapshot` | `MESSAGES_SNAPSHOT` (the text, and the cards as activity messages) |
| `run-finish` | `RUN_FINISHED`, `outcome: success`, or `cancelled` |
| `error` | `RUN_ERROR`; a recoverable one is `CUSTOM super.error` |
| `usage`, `metering`, `context-built`, `job-*`, `message`, `user-responded` | `CUSTOM super.<type>`, the rest of the event is the value |

Decoding is the inverse. The person's answer comes back as `RunAgentInput.resume` (`decoder.resume(entries)`, or read
from `RUN_STARTED.input.resume`): `resolved` becomes a submit, `cancelled` a cancel. `resumeEntryFromAction` goes the other
way. AG-UI cannot tell a form answer from a selection or a confirmation, so the three are one `resolved`.

## Run events to the AI SDK UI message stream (table B)

The stream header is `x-vercel-ai-ui-message-stream: v1` (`UI_MESSAGE_STREAM_HEADERS`); `toSse` frames chunks as
server-sent events ending with `[DONE]`.

| Run event | UI message chunk |
| --- | --- |
| `run-start` | `start` (`messageId` is the run id) |
| `step-start` / `step-finish` | `start-step` / `finish-step` |
| `text-delta` | `text-start`, `text-delta`, `text-end` (part id `${runId}:${step}`) |
| `reasoning-delta` | `reasoning-start`, `reasoning-delta`, `reasoning-end` |
| `tool-call` | `tool-input-available`, always `dynamic: true`: the protocol's tools are not the host's typed tools |
| `tool-result` | `tool-output-available`, or `tool-output-error` |
| `card`, `card-updated` | `data-super-card` with the card's id as the part id, so a later update replaces it |
| `awaiting-user` | the card, then `tool-approval-request` for a yes/no card (`isConfirm`), else `data-super-awaiting-user` |
| `user-responded` | `tool-approval-response` for an approval; nothing for other cards (the next run continues) |
| `run-finish` | `finish` with `finishReason`, and `messageMetadata.super` carrying the run's usage and step count |
| `error` | `error` |
| `usage` (transient), `run-snapshot`, `metering`, `context-built`, `job-*` | `data-super-<type>` |

The decoder needs a run id, from `start.messageId` or the `runId` option, and throws a `RangeError` without one: a run
has no message id of its own and making one up would put an invented id into data.

## What is lost

Every row is in a golden file's `loss` list, with the reason. In short:

- **Sequence numbers** (`seq`): neither protocol has one. A decoder cannot give them back.
- **Step finish reason and usage**: AG-UI's `STEP_FINISHED` has only a name; the AI SDK's `finish-step` has no fields.
- **Run usage and step count**: AG-UI's `RUN_FINISHED` has none (see the usage caveat below); the AI SDK carries them in
  `messageMetadata.super`, which a UI can read but the SDK gives no meaning.
- **`tool-call.loading` and `repaired`**: no field on either side.
- **`tool-call-input-delta`**: a preview of the arguments as an object. Both protocols stream the arguments as text, the
  whole call is sent at `tool-call`, and the preview is dropped (and, for AI SDK, `partialCard` too).
- **`tool-result.ms`**: no duration on either side. The AG-UI decoder makes one from the events' `timestamp` when they have it; the AI SDK has none to read.
- **A failed result's `output`** on the AI SDK: `tool-output-error` has only `errorText`.
- **`error`** on the AI SDK: the chunk has only a text, so the code and any other field of the error are lost (AG-UI keeps `code`, and reports any other field).
- **`run-finish.finishReason`** on AG-UI: only success or cancelled; `length` is success.
- **`run-start.threadId`** on the AI SDK: a chat's id is on the request, not in the stream.
- **On decode**: everything that is not a run's output (state, patches, raw events, sub-agents, chunk forms, message
  metadata, custom parts, steering messages, other data parts, preliminary tool outputs, messages of the user).

Round trips are therefore not the identity: the golden files show each one (`roundtrip`, `roundtrip_loss`), and the
differences are exactly the list above.

## Things the real packages showed that the review of these protocols did not expect

- AG-UI 1.0.4 has a native `usage` on `RUN_FINISHED` and `RUN_ERROR`, and the AI SDK `finish` chunk carries a
  `finishReason` and `messageMetadata`. So both have a place for usage; the reason it is not mapped onto AG-UI is below.
- A tool approval or an AG-UI interrupt is a run that has *finished its turn*, not one that is over. Both decoders hold
  back the run-finish while a card waits (AI SDK: `finish` with `tool-calls` while a card waits), so a suspended run does
  not look finished.

## Open points for the owner

- **Usage is not mapped onto `RUN_FINISHED.usage`.** Whether `inputTokens` includes cached tokens is not decided (O1 of the
  review), and AG-UI, the AI SDK and OpenTelemetry disagree on it. Until it is, the adapters report usage as lost on AG-UI
  and carry it as protocol data on the AI SDK, instead of choosing a reading.
- **`ai-sdk.tool-approval` is a card kind this package makes up.** An AI SDK approval request has no card, and a decoded
  run needs one to carry the person's answer. It is a synthetic kind (`AI_SDK_APPROVAL_CARD_KIND`), not a registered one.
- **Confirm or form** depends on the caller's `isConfirm` and `interruptReason` options: a card's kind does not say
  whether it is a yes/no question. No default guesses.
- **The AG-UI resume payload** collapses submit, select and confirm into one `resolved`.

## MCP (`interop/mcp`)

Written against MCP `2026-07-28` and MCP Apps `2026-01-26`; every rule below was read from those specifications, and the
functions are **not** tested against an MCP SDK (none is a dependency). Pure functions: nothing is renamed, and where a word
has no counterpart the answer is `null` or an absent field, never a guess.

| Idea | Here | MCP | Function |
| --- | --- | --- | --- |
| What a tool may do | `authority`: `read`, `draft`, `act` | `annotations.readOnlyHint`, `destructiveHint` | `toolAnnotationsFromAuthority`, `authorityFromAnnotations` |
| Colours and fonts | `HostTheme` | MCP Apps `hostContext.theme` and `styles.variables` | `hostThemeToMcpAppsContext`, `hostThemeFromMcpAppsContext` |
| Where a card is shown | `placement`: `inline`, `panel`, `document` | `displayMode`: `inline`, `fullscreen`, `pip` | `placementToDisplayMode`, `displayModeToPlacement` |
| What the person did | card response `type` | elicitation `action`: `accept`, `decline`, `cancel` | `cardResponseToElicitationAction` |

- **Authority and annotations.** `read` is `readOnlyHint: true`; `draft` is `readOnlyHint: false, destructiveHint: false`;
  `act` is `readOnlyHint: false, destructiveHint: true`. A missing or unknown authority gives no hints, which an MCP client
  reads as its cautious defaults (not read-only, destructive). The other way round, **MCP says a client MUST treat tool
  annotations as untrusted unless they come from a trusted server**, so `authorityFromAnnotations` returns `null` unless the
  caller passes `{ trusted: true }`; whether a server is trusted is the host's policy, and a tool with no authority gets no
  preset anyway. Even then, hints that do not say (no boolean `readOnlyHint`) give `null`.
- **Plugin authority is a claim too.** A plugin's own `authority` is what it says about itself: a plugin from a source the
  host does not trust can declare `read` for a tool that deletes things. Whether to believe it is the host's policy, as with
  MCP annotations. (This is the sentence that `wire-contracts.md` in the dev docs lacks; that repository is not touched here.)
- **Theme.** `MCP_APPS_STYLE_VARIABLES` is the full list of the 76 variables MCP Apps standardizes (the draft spec has the
  same 76). Thirteen of the 15 tokens map to a variable (`background`, `surface`, `surface-raised`, `border`, `text`, `text-muted`,
  `font-sans`, `font-mono`, `radius`, and `positive`, `negative`, `warning`, `info` as the *text* colour of that state).
  `accent` and `accent-contrast` have none: MCP Apps has no brand colour, and no variable is borrowed. Going the other way,
  every variable that no token maps to is not read, and an unsafe value (`url(...)`, `;`, `{`) is dropped by itself.
  A `light-dark(a, b)` value, which MCP Apps asks hosts to use, is passed through as it is.
- **Placement.** `panel` is `fullscreen` or `pip`: the caller chooses (`panelAs`), nothing is assumed. `document` has no
  counterpart, because MCP Apps has no place inside a document: `null`.
- **Elicitation.** `submit`, `select` and `confirm` are `accept`; `cancel` and `dismiss` are `cancel`. **Nothing is
  `decline`**, MCP's explicit refusal: this protocol has no such action (a refusal is a `cancel` on a confirm card today),
  and adding one would be a new enum value, which is the owner's call. Not mapped in the other direction: `accept` does
  not say whether the card was a form, a selection or a yes/no.

## OpenTelemetry GenAI (`interop/otel`)

Pure functions that return the attribute dictionary of a span; the application makes the span, so this package has no
`@opentelemetry/*` dependency. The attributes are in **Development** status and are **not checked against an OpenTelemetry
package**; the names are in one object (`GEN_AI`) and in `conformance/interop-otel.v0.json`, so a rename is an edit in two
places. Names were read from the GenAI conventions repository (`semantic-conventions-genai`, `main`, 2026-11-25).

| Run | Attribute |
| --- | --- |
| `run-start` (`runAttributes`) | `gen_ai.operation.name: invoke_agent`; `threadId` is `gen_ai.conversation.id` |
| `tool-call` and its `tool-result` (`toolAttributes`, span name `toolSpanName`) | `gen_ai.operation.name: execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`; a `failure` sets `error.type: _OTHER` |
| `usage`, `run-finish.usage` (`usageAttributes`) | `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `reasoning.output_tokens` |
| gateway meters (`usageAttributesFromMeters`) | the same, and `cache_write.input_tokens` |
| `finishReason` (`finishReasonAttributes`) | `gen_ai.response.finish_reasons: [stop \| length \| tool_calls \| content_filter \| error \| interrupted]` |

- **Counting is an argument, never a guess.** `gen_ai.usage.input_tokens` SHOULD include cached tokens (cache reads and
  writes), and `gen_ai.usage.output_tokens` SHOULD include reasoning tokens. Whether a run's `inputTokens` includes cached
  tokens is the open question O1 (`RUN-EVENTS.md`); whether its `outputTokens` includes reasoning is not written down
  either. So `usageAttributes(usage, { input, output })` takes how the usage counts, and throws a `RangeError` for numbers
  that cannot be that reading (an "includes" total smaller than its part). **`outputTokens` is a second open reading that
  the review did not list.** A count that is absent is left out, never written as 0.
- **`RunUsage` has no cache writes.** If the reading excludes cached tokens and some were written, the input is understated
  by them; use `usageAttributesFromMeters`, whose `Usage` has `cache_write`.
- **A failure is `_OTHER`**, not its message: `error.type` must be low-cardinality, and a tool failure is free text. A run's
  `error.type` can be given by the caller (`runAttributes(start, { errorType })`).
- **`cancelled` is `interrupted`**, the conventions' word for a caller that stopped a generation without an error;
  `unknown` has no word and gives no attribute. The other words are OpenAI-style, as the gateway's `tool_calls` already is;
  the conventions say a finish reason is the provider's own.
- **Not done:** `run-start.trace` (`traceparent`/`tracestate`) from the review's A9 is a change to the wire shape, so it is
  left for the owner; no span is built and no context is propagated.

### What the specifications showed that the review did not expect

- The OpenTelemetry attributes **moved** to a new repository (`semantic-conventions-genai`); the older registry marks them
  deprecated, and there calls the cache-write count `gen_ai.usage.cache_creation.input_tokens`. The review's name
  `cache_write.input_tokens` is the current one.
- MCP Apps has no accent colour, and its state colours (`success`, `danger`, `warning`, `info`) come in background, text,
  border and ring forms, so one token cannot fill them.
