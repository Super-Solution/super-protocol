# Run events

What an agent turn reports while it runs. A turn that runs in the page and a turn that runs on a server report the
same events, so one chat UI follows either. The loop behind the events can be written in any language: this is the
JSON it sends.

The names and fields are the ones Super Chat's `RunEvent` uses, so a Super Chat client folds a conforming stream
without a mapping layer (see Super Chat's `docs/guide/server-run.md`).

```
run-start → step-start → text-delta … → usage → step-finish → run-finish
```

## The events

Every event is a JSON object with a `type`. Fields marked `?` are optional. Any event may also carry `seq?` (below).

| `type` | Fields | Means |
| --- | --- | --- |
| `run-start` | `runId`, `mode` (`stream`, `sync`, `background`), `threadId?` | A run began. `threadId` names the conversation it belongs to. |
| `run-snapshot` | `parts[]`, `cards[]`, `usage?`, `steps?` | Everything the run has produced so far. **Replaces** what the follower holds. |
| `context-built` | `trace`, `system`, `toolNames[]` | What was sent to the model and why. Optional; inspectors read it. |
| `step-start` | `step` | A model call began. Steps count from 0. |
| `text-delta` | `delta`, `id?` | More of the answer. |
| `reasoning-delta` | `delta`, `id?` | More of the model's reasoning. |
| `tool-call-input-delta` | `callId`, `name`, `partialInput`, `partialCard?`, `loading?` | A preview of a tool call's arguments while the model writes them. Never stored. |
| `tool-call` | `callId`, `name`, `input`, `repaired?`, `loading?` | The model called a tool. |
| `awaiting-user` | `callId`, `card` | The run waits for the person to answer this card. |
| `user-responded` | `callId`, `action` | The person answered. |
| `tool-result` | `callId`, `name`, `output`, `failure?`, `ms` | The call's outcome, failures included. `ms` is how long it took. |
| `card` | `card` | A card to show. |
| `card-updated` | `cardId`, `spec` | A card's content changed. |
| `step-finish` | `step`, `finishReason`, `usage?` | A model call ended. |
| `job-started` | `handle` (`provider`, `id`) | A provider accepted a background job. |
| `job-status` | `handle`, `status` | That job's state. |
| `message` | `parts[]` | Content parts to append as they are. |
| `metering` | `record` | One usage record per model call and one per run, for a ledger. Not added to the live total. |
| `usage` | `usage` | One model call's usage. The only event a follower adds up. |
| `run-finish` | `runId`, `finishReason`, `usage`, `steps` | The run ended. `usage` and `steps` are totals and replace what the follower added up. |
| `error` | `error`, `recoverable` | Something failed. A run that failed sends `recoverable: false`, then `run-finish` with `finishReason: "error"`. |

`finishReason` is one of `stop`, `length`, `tool-calls`, `content-filter`, `cancelled`, `error`, `unknown`.
`cancelled` is the person stopping the run: an outcome, not a fault.

Shared shapes:

- **Card**: `{ id, spec: { kind, … }, callId?, expired?, action? }`. `kind` routes the card to a renderer; the rest
  of `spec` belongs to that kind.
- **Card action**: `{ cardId, callId?, kind, type, value?, at }`. `type` is `submit`, `select`, `confirm`, `cancel`
  or `dismiss`; `at` is milliseconds since the epoch.
- **Usage**: `{ inputTokens?, outputTokens?, totalTokens?, cachedInputTokens?, reasoningTokens? }`, each a
  non-negative number.
- **Content part**: an object with a `type` (`text`, `reasoning`, `tool-call`, `tool-result`, …).

The protocol does not look inside tool `input` and `output`, `error`, `trace`, `record`, `loading`, a card spec
beyond `kind` or a content part beyond `type`. They belong to the tool, the card kind or the host.

## Optional fields that let another protocol map a run without guessing

All three are optional: a producer may leave them out, `validateRunEvent` accepts an event with or without them, and
checks their type only when they are there (`threadId` and `id` a non-empty string, `seq` a non-negative integer).

- **`seq`** (any event): a counter that rises by one with each event of a run, from 0. A follower that sees a gap knows
  it missed events and can ask for a `run-snapshot`. A producer that numbers its events numbers all of them.
- **`threadId`** (`run-start`): the conversation the run belongs to, for a follower that groups runs. A host that keeps
  no thread leaves it out; an adapter that needs one (AG-UI's `RUN_STARTED` has one) then makes one up from the host's
  own id.
- **`id`** (`text-delta`, `reasoning-delta`): the message the text belongs to. Without one, a follower and every adapter
  use `${runId}:${step}`, so the same events always give the same ids.

## The `error` payload

`error.error` is `unknown` and the validator does not look inside it. Producers **should** send
`{ message: string, code?: string, kind?: string }`: `JSON.stringify` of a thrown `Error` drops its message, and every
protocol that reports a failure to a person (AG-UI's `RUN_ERROR`, the AI SDK's `error` chunk) wants a sentence. Making
the validator require it would reject producers that send a plain string today, so it stays advice for now.

## The same things under the gateway's names

`router.ts` (the inference gateway) and these events grew separately, so one idea is spelled two ways. The conversions
are pure functions in `@supersolutions/super-protocol/mapping` (and `FinishReasonFromGateway`, `RunUsageFromMeters`, ...
in Go; `finish_reason_from_gateway`, `run_usage_from_meters`, ... in Python). Nothing renames a field on either side.

| Idea | Gateway | Run | Conversion |
| --- | --- | --- | --- |
| Why it stopped | `finish_reason`: `stop`, `length`, `tool_calls` | `finishReason`: `stop`, `length`, `tool-calls`, `content-filter`, `cancelled`, `error`, `unknown` | `finishReasonFromGateway` gives `unknown` for a value it does not know or that is absent. `finishReasonToGateway` gives `null` for `content-filter`, `cancelled`, `error` and `unknown`: the gateway has no word for them and the function does not invent one. |
| A tool call's id | `id` | `callId` | The same string. |
| Token counts | `{ input, cached, cache_write, output }` | `{ inputTokens, cachedInputTokens, outputTokens, ... }` | `runUsageFromMeters`, `metersFromRunUsage`: see below. |

### Does `input` include the cached tokens? Not decided

Two readings are in use, and the protocol has not said which one `Usage.input` and `RunUsage.inputTokens` mean:

- **includes-cached**: `input` is everything the model read, tokens read from or written to the cache included.
  OpenTelemetry's GenAI conventions define `gen_ai.usage.input_tokens` this way, and so do OpenAI-style APIs.
- **excludes-cached**: `input` is only the tokens that were neither read from nor written to the cache, and the cached
  ones are reported beside it. Gateways that pass through Anthropic's Messages API usage report it this way, so on a
  heavily cached turn `input` can legitimately be 1.

Reading one as the other silently under- or over-states the tokens, so the decision belongs to the owner and **the
conversion functions take the reading of each side as an argument**: `{ meters, run }`, each `"includes-cached"` or
`"excludes-cached"`. They never pick one. With the same numbers the two readings differ like this
(`input 100, cached 30, cache_write 10`):

| `meters` reads | `run` reads | `inputTokens` |
| --- | --- | --- |
| includes-cached | includes-cached | 100 |
| includes-cached | excludes-cached | 60 |
| excludes-cached | includes-cached | 140 |
| excludes-cached | excludes-cached | 100 |

What is lost: `RunUsage` has no `cache_write`, so going to a run it is dropped (or stays inside `inputTokens` when the
run includes cached tokens) and coming back it is 0; `images`, `video_ms`, `audio_ms` and `tasks` have no run
counterpart; `reasoningTokens` and `totalTokens` have no meter. A function **refuses** instead of guessing: it throws
(Go returns an error) when a count is missing or negative, or when an "includes-cached" `input` is smaller than the
cached tokens (so it cannot include them). `conformance/protocol.v1.json` pins it as `mapping`.

## Rules

1. **Only `run-finish` ends a run.** A closed connection does not. A run that waits for approval closes its stream
   and stays suspended for as long as the person takes; a dropped connection leaves the run working on the server.
2. **Correlate by `callId`, never by position.** Per call: `tool-call`, then its `card` / `awaiting-user` /
   `user-responded`, then exactly one `tool-result`. All of a step's results arrive before the next `step-start`.
3. **A snapshot replaces.** A follower that joins part-way, or lost part of the stream, gets a `run-snapshot` and
   drops what it held for the run. A card that is still waiting is announced again with `awaiting-user` after it.
4. **Usage is counted once.** Add up `usage` events; `step-finish` repeats a step's numbers and `run-finish` carries
   the total, which replaces the sum.
5. **Skip what you do not know.** A follower ignores an event type it does not recognise; later versions add types.
   A producer sends only the types above.

## What a stopped stream means

`runStreamOutcome(events)` answers it the same way in every language, from the events the stream delivered:

| Outcome | When | What to do |
| --- | --- | --- |
| `finished` | The last word was `run-finish`. | Commit the turn. |
| `awaiting-user` | An `awaiting-user` has no `user-responded` or `tool-result` after it. | Show the card and wait. |
| `interrupted` | The run was still working. | Follow it again; it may well be running still. Do not report a failure. |
| `empty` | No run event at all. | Nothing to follow. |

`run-start` and `run-snapshot` start the picture over, so events from before a reconnect do not leak into the answer.

## Checking what you send

`validateRunEvent(event)` returns a list of issues, each `{ path, code, message, hint? }` (see [`ISSUES.md`](ISSUES.md));
an empty list means the event is valid. It is for the side that produces events: run it in the tests of a server that
streams them.

```ts
import { validateRunEvent, runStreamOutcome } from "@supersolutions/super-protocol/run";

validateRunEvent({ type: "run-finish", runId: "run_1", finishReason: "done", usage: {}, steps: 1 });
// [{ path: "finishReason", code: "enum", message: "must be one of stop, length, tool-calls, content-filter, cancelled, error, unknown" }]
```

```go
issues := protocol.ValidateRunEvent(event)        // event is decoded JSON
outcome := protocol.RunStreamOutcomeOf(events)    // protocol.RunStreamAwaitingUser, …
```

```python
issues = validate_run_event(event)
outcome = run_stream_outcome(events)              # "finished", "awaiting-user", "interrupted" or "empty"
```

All three give the same answers, messages included (`conformance/protocol.v1.json`: `run_event`, `run_event_type`,
`run_stream_outcome`).

## Transport

Not prescribed. Over server-sent events, send one event per frame with the event as JSON in `data`; the package's SSE
parser reads it. How a client asks for a snapshot, answers a card or cancels a run is the server's own API.
