# Interop with AG-UI and the AI SDK (draft)

> **Draft.** These modules are not stable and can change in any release. The golden files are `*.v0.json`, outside
> `protocol.v1.json`, and nothing here is part of the wire contract.

A run (see [`RUN-EVENTS.md`](RUN-EVENTS.md)) is a list of events. Two other protocols carry the same thing, and a host
that already speaks one of them should not need a second client to show a run:

| Module | Other side | Golden file |
| --- | --- | --- |
| `@supersolutions/super-protocol/interop/ag-ui` | [AG-UI](https://docs.ag-ui.com) events | `conformance/interop-ag-ui.v0.json` |
| `@supersolutions/super-protocol/interop/ai-sdk` | the Vercel AI SDK UI message stream (`useChat`) | `conformance/interop-ai-sdk.v0.json` |

Both are TypeScript only. They are not ported to Go or Python: a draft adapter that is wrong in three languages is worse
than one that is wrong in one, and the golden files already say what a port has to do.

## How they work

Each module has the same shape, so the next adapter looks like the last:

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
