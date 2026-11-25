/**
 * Run events <-> AG-UI events (DRAFT: not stable; see docs/INTEROP.md for the table and for what is lost).
 *
 * `createEncoder` turns a run's events into the events an AG-UI client reads; `createDecoder` turns an AG-UI agent's
 * events into run events, so a client built on this protocol can sit in front of an AG-UI backend. Both are state
 * machines with no I/O. The AG-UI event shapes here are structural (`{ type: "TEXT_MESSAGE_START", ... }`): this
 * module imports nothing, and `conformance/interop-ag-ui.v0.json` is checked against `@ag-ui/core`'s own schemas by
 * `scripts/export-interop-ag-ui.mjs`.
 *
 * What the state is for:
 * - AG-UI wants a message to be opened, filled and closed; a run's `text-delta` has no start or end. The encoder opens a
 *   message at the first delta and closes it before the next tool call, step end, card or the end of the run.
 * - AG-UI wants an id on every message; a run's delta usually has none. The id is `${runId}:${step}`, the one RUN-EVENTS.md
 *   says a follower uses, so the same events always give the same ids. The decoder leaves `id` out again when it is that.
 * - A card that waits for the person (`awaiting-user`) is an interrupt in AG-UI: the run finishes with
 *   `outcome: { type: "interrupt", interrupts: [...] }`, all open ones in one event. The encoder sends it when the run's
 *   stream ends with a card unanswered (`end()`), which is the moment a run that waits closes its stream.
 */
import type { RunCard, RunCardAction, RunEvent } from "../run.js";
import { errorMessage, isRecord, isText, jsonText, runMachine, type AdapterOptions, type StreamMachine } from "./types.js";

/** An AG-UI event, structurally: a `type` and whatever fields that type has. */
export type AgUiEvent = { type: string } & Record<string, unknown>;

/** One answer of the person to an interrupt: an entry of AG-UI's `RunAgentInput.resume`. */
export interface AgUiResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

/** The `activityType` of the ACTIVITY_SNAPSHOT that carries a card. */
export const AG_UI_CARD_ACTIVITY = "super-card";
/** The prefix of the CUSTOM event names that carry a run event AG-UI has no event for. */
export const AG_UI_CUSTOM_PREFIX = "super.";

export interface AgUiEncoderOptions extends AdapterOptions {
  /** The thread of the run, when the `run-start` does not say. Without either, the run id is used. */
  threadId?: string;
  /** The run id, for a stream that starts without its `run-start` (a follower that joined part-way). */
  runId?: string;
  /** Why a card waits: AG-UI's `reason`. Default `"input_required"`; answer `"confirmation"` for a yes/no card. */
  interruptReason?: (card: RunCard) => string;
}

export interface AgUiDecoderOptions extends AdapterOptions {
  /** The run id, for a stream that starts without RUN_STARTED. */
  runId?: string;
  /** When a person's answer is read from `resume`; default `Date.now`. A test passes a fixed clock. */
  now?: () => number;
}

// Run events that AG-UI has no event of its own for. Each travels as CUSTOM `super.<type>` with the rest of the event as
// its value, so nothing in them is lost and the decoder gives the event back.
const CUSTOM_TYPES = ["usage", "metering", "context-built", "job-started", "job-status", "message", "user-responded"] as const;
const FAILURE = `${AG_UI_CUSTOM_PREFIX}tool-failure`;
const RECOVERABLE_ERROR = `${AG_UI_CUSTOM_PREFIX}error`;

const without = (event: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) if (!keys.includes(key)) rest[key] = value;
  return rest;
};

/** The entry of `RunAgentInput.resume` for what the person did: cancel and dismiss are `cancelled`, the rest `resolved`. */
export function resumeEntryFromAction(callId: string, action: RunCardAction): AgUiResumeEntry {
  const cancelled = action.type === "cancel" || action.type === "dismiss";
  return { interruptId: callId, status: cancelled ? "cancelled" : "resolved", ...(!cancelled && action.value !== undefined ? { payload: action.value } : {}) };
}

export function createEncoder(options: AgUiEncoderOptions = {}): StreamMachine<RunEvent, AgUiEvent> {
  const loss = options.onLoss ?? (() => {});
  const reason = options.interruptReason ?? (() => "input_required");
  let runId = options.runId ?? "run";
  let threadId = options.threadId;
  let step = 0;
  let text: string | null = null;
  let reasoning: string | null = null;
  let finished = false;
  let errored = false;
  let stepsSeen = 0;
  const cards = new Map<string, RunCard>();
  const waiting = new Map<string, { id: string; reason: string; toolCallId: string }>();
  const thread = () => threadId ?? runId;
  const messageId = () => `${runId}:${step}`;

  const closeMessages = (): AgUiEvent[] => {
    const out: AgUiEvent[] = [];
    if (reasoning !== null) {
      out.push({ type: "REASONING_MESSAGE_END", messageId: reasoning }, { type: "REASONING_END", messageId: reasoning });
      reasoning = null;
    }
    if (text !== null) {
      out.push({ type: "TEXT_MESSAGE_END", messageId: text });
      text = null;
    }
    return out;
  };
  const activity = (card: RunCard): AgUiEvent => ({ type: "ACTIVITY_SNAPSHOT", messageId: card.id, activityType: AG_UI_CARD_ACTIVITY, content: card, replace: true });
  const custom = (name: string, value: unknown): AgUiEvent => ({ type: "CUSTOM", name, value });
  const lost = (event: RunEvent, field: string, why: string) => {
    if ((event as Record<string, unknown>)[field] !== undefined) loss({ type: event.type, field, reason: why });
  };
  const interrupt = (): AgUiEvent => ({ type: "RUN_FINISHED", threadId: thread(), runId, outcome: { type: "interrupt", interrupts: [...waiting.values()] } });

  const encode = (event: RunEvent): AgUiEvent[] => {
    if (!isRecord(event) || typeof event.type !== "string") {
      loss({ type: String((event as { type?: unknown } | null)?.type), reason: "not a run event" });
      return [];
    }
    if (finished) {
      // RUN_ERROR already said the run failed: the run-finish that follows an unrecoverable error adds nothing.
      if (!(errored && event.type === "run-finish" && event.finishReason === "error")) loss({ type: event.type, reason: "after the run's last AG-UI event" });
      return [];
    }
    lost(event, "seq", "AG-UI events carry no sequence number");
    switch (event.type) {
      case "run-start": {
        runId = event.runId;
        threadId = event.threadId ?? options.threadId;
        if (event.mode !== "stream") loss({ type: event.type, field: "mode", reason: "AG-UI has no run mode; a decoded run is a stream" });
        lost(event, "protocol", "AG-UI carries its own protocol version, not this one");
        return [{ type: "RUN_STARTED", threadId: thread(), runId }];
      }
      case "step-start":
        step = event.step;
        stepsSeen += 1;
        return [...closeMessages(), { type: "STEP_STARTED", stepName: `step-${event.step}` }];
      case "step-finish":
        lost(event, "finishReason", "AG-UI's STEP_FINISHED has only a name");
        lost(event, "usage", "AG-UI's STEP_FINISHED has only a name");
        return [...closeMessages(), { type: "STEP_FINISHED", stepName: `step-${event.step}` }];
      case "text-delta": {
        if (event.delta === "") return [];
        const id = event.id ?? messageId();
        const out: AgUiEvent[] = [];
        if (reasoning !== null) out.push(...closeMessages());
        if (text !== null && text !== id) out.push(...closeMessages());
        if (text === null) {
          out.push({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
          text = id;
        }
        out.push({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: event.delta });
        return out;
      }
      case "reasoning-delta": {
        if (event.delta === "") return [];
        const id = event.id ?? `${messageId()}:reasoning`;
        const out: AgUiEvent[] = [];
        if (text !== null) out.push(...closeMessages());
        if (reasoning !== null && reasoning !== id) out.push(...closeMessages());
        if (reasoning === null) {
          out.push({ type: "REASONING_START", messageId: id }, { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" });
          reasoning = id;
        }
        out.push({ type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: event.delta });
        return out;
      }
      case "tool-call-input-delta":
        loss({ type: event.type, reason: "a preview of the arguments as an object; AG-UI streams the arguments as text, and the whole call is sent at tool-call" });
        return [];
      case "tool-call":
        lost(event, "repaired", "AG-UI has no field for it");
        lost(event, "loading", "AG-UI has no field for it");
        return [
          ...closeMessages(),
          { type: "TOOL_CALL_START", toolCallId: event.callId, toolCallName: event.name },
          { type: "TOOL_CALL_ARGS", toolCallId: event.callId, delta: jsonText(event.input, "{}") },
          { type: "TOOL_CALL_END", toolCallId: event.callId },
        ];
      case "tool-result": {
        const failed = event.failure !== undefined;
        lost(event, "ms", "AG-UI's TOOL_CALL_RESULT has no duration");
        const out: AgUiEvent[] = [];
        // A failure is not a result AG-UI can tell from a normal one: say it in a CUSTOM event just before.
        if (failed) out.push(custom(FAILURE, { toolCallId: event.callId, failure: event.failure, ms: event.ms }));
        const content = failed ? String(event.failure) : typeof event.output === "string" ? event.output : jsonText(event.output);
        out.push({ type: "TOOL_CALL_RESULT", messageId: `${event.callId}:result`, toolCallId: event.callId, content, role: "tool" });
        return out;
      }
      case "card": {
        cards.set(event.card.id, event.card);
        return [...closeMessages(), activity(event.card)];
      }
      case "card-updated": {
        const card = { ...(cards.get(event.cardId) ?? { id: event.cardId }), spec: event.spec } as RunCard;
        cards.set(card.id, card);
        return [...closeMessages(), activity(card)];
      }
      case "awaiting-user": {
        cards.set(event.card.id, event.card);
        waiting.set(event.callId, { id: event.callId, reason: reason(event.card), toolCallId: event.callId });
        return [...closeMessages(), activity(event.card)];
      }
      case "run-snapshot": {
        const messages: Array<Record<string, unknown>> = [];
        const words = event.parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string);
        if (words.length > 0) messages.push({ id: messageId(), role: "assistant", content: words.join("") });
        if (event.parts.some((p) => p.type !== "text" || typeof p.text !== "string")) loss({ type: event.type, field: "parts", reason: "only text parts are carried; AG-UI messages are not the protocol's parts" });
        for (const card of event.cards) {
          cards.set(card.id, card);
          messages.push({ id: card.id, role: "activity", activityType: AG_UI_CARD_ACTIVITY, content: card });
        }
        lost(event, "usage", "AG-UI's MESSAGES_SNAPSHOT has no usage");
        lost(event, "steps", "AG-UI's MESSAGES_SNAPSHOT has no step count");
        return [...closeMessages(), { type: "MESSAGES_SNAPSHOT", messages }];
      }
      case "error": {
        if (event.recoverable) return [custom(RECOVERABLE_ERROR, without(event, "type"))];
        // RUN_ERROR ends the run in AG-UI: the run-finish that follows has nothing left to say.
        finished = true;
        errored = true;
        const error = isRecord(event.error) && isText(event.error.code) ? { code: event.error.code } : {};
        if (isRecord(event.error) && Object.keys(event.error).some((k) => k !== "message" && k !== "code")) lost(event, "error", "RUN_ERROR has only a message and a code; any other field of the error is not carried");
        return [...closeMessages(), { type: "RUN_ERROR", message: errorMessage(event.error), ...error }];
      }
      case "run-finish": {
        if (Object.keys(event.usage ?? {}).length > 0) loss({ type: event.type, field: "usage", reason: "left out until the counting of input tokens is decided (docs/RUN-EVENTS.md)" });
        if (event.steps !== stepsSeen) loss({ type: event.type, field: "steps", reason: "AG-UI's RUN_FINISHED has no step count; a decoder counts the steps it saw" });
        if (event.finishReason !== "cancelled" && event.finishReason !== "stop") loss({ type: event.type, field: "finishReason", reason: `AG-UI says only success or cancelled; ${event.finishReason} is success` });
        finished = true;
        const outcome = event.finishReason === "cancelled" ? { type: "cancelled" } : { type: "success" };
        return [...closeMessages(), { type: "RUN_FINISHED", threadId: thread(), runId, outcome }];
      }
      case "user-responded":
        waiting.delete(event.callId);
        return [custom(`${AG_UI_CUSTOM_PREFIX}user-responded`, without(event, "type"))];
      default:
        if ((CUSTOM_TYPES as readonly string[]).includes(event.type)) return [custom(`${AG_UI_CUSTOM_PREFIX}${event.type}`, without(event as Record<string, unknown>, "type"))];
        loss({ type: String((event as { type: unknown }).type), reason: "not a run event type this version knows" });
        return [];
    }
  };

  return {
    push: encode,
    end() {
      const out = closeMessages();
      if (!finished && waiting.size > 0) {
        out.push(interrupt());
        finished = true;
      }
      return out;
    },
  };
}

export function createDecoder(options: AgUiDecoderOptions = {}): StreamMachine<AgUiEvent, RunEvent> & { resume(entries: readonly AgUiResumeEntry[]): RunEvent[] } {
  const loss = options.onLoss ?? (() => {});
  const now = options.now ?? Date.now;
  let runId = options.runId ?? "";
  let step = 0;
  let steps = 0;
  const textRoles = new Map<string, string>();
  const calls = new Map<string, { name: string; args: string; at?: number }>();
  const failures = new Map<string, { failure: string; ms?: number }>();
  const cards = new Map<string, RunCard>();
  const interrupts = new Map<string, { callId: string; card?: RunCard }>();
  const synthesized = (id: unknown) => id === `${runId}:${step}`;
  const lost = (event: AgUiEvent, field: string, why: string) => {
    if (event[field] !== undefined) loss({ type: event.type, field, reason: why });
  };
  const isCard = (v: unknown): v is RunCard => isRecord(v) && isText(v.id) && isRecord(v.spec) && isText(v.spec.kind);

  const resume = (entries: readonly AgUiResumeEntry[]): RunEvent[] => {
    const out: RunEvent[] = [];
    for (const entry of entries) {
      const open = interrupts.get(entry.interruptId);
      if (open === undefined || open.card === undefined) {
        loss({ type: "resume", reason: `no open interrupt ${entry.interruptId} with a card to answer` });
        continue;
      }
      interrupts.delete(entry.interruptId);
      const cancelled = entry.status === "cancelled";
      const action: RunCardAction = { cardId: open.card.id, callId: open.callId, kind: open.card.spec.kind, type: cancelled ? "cancel" : "submit", at: now() };
      if (!cancelled && entry.payload !== undefined) action.value = entry.payload;
      out.push({ type: "user-responded", callId: open.callId, action });
    }
    return out;
  };

  const decode = (event: AgUiEvent): RunEvent[] => {
    if (!isRecord(event) || typeof event.type !== "string") {
      loss({ type: String((event as { type?: unknown } | null)?.type), reason: "not an AG-UI event" });
      return [];
    }
    switch (event.type) {
      case "RUN_STARTED": {
        runId = String(event.runId);
        step = 0;
        steps = 0;
        // An encoder without a thread uses the run id as the thread, so a thread that is the run id says nothing.
        const thread = String(event.threadId);
        const out: RunEvent[] = [{ type: "run-start", runId, mode: "stream", ...(thread === runId ? {} : { threadId: thread }) }];
        const input = event.input;
        if (isRecord(input) && Array.isArray(input.resume)) out.push(...resume(input.resume as AgUiResumeEntry[]));
        return out;
      }
      case "STEP_STARTED": {
        const named = /^step-(\d+)$/.exec(String(event.stepName));
        step = named ? Number(named[1]) : steps;
        steps = step + 1;
        return [{ type: "step-start", step }];
      }
      case "STEP_FINISHED":
        return [{ type: "step-finish", step, finishReason: "unknown" }];
      case "TEXT_MESSAGE_START":
        textRoles.set(String(event.messageId), String(event.role ?? "assistant"));
        return [];
      case "TEXT_MESSAGE_CONTENT": {
        const role = textRoles.get(String(event.messageId)) ?? "assistant";
        if (role !== "assistant") {
          loss({ type: event.type, reason: `a ${role} message is not output of the run` });
          return [];
        }
        return [{ type: "text-delta", delta: String(event.delta), ...(synthesized(event.messageId) ? {} : { id: String(event.messageId) }) }];
      }
      case "REASONING_MESSAGE_CONTENT":
        return [{ type: "reasoning-delta", delta: String(event.delta), ...(event.messageId === `${runId}:${step}:reasoning` ? {} : { id: String(event.messageId) }) }];
      case "TEXT_MESSAGE_END":
      case "REASONING_START":
      case "REASONING_MESSAGE_START":
      case "REASONING_MESSAGE_END":
      case "REASONING_END":
        return [];
      case "TOOL_CALL_START":
        calls.set(String(event.toolCallId), { name: String(event.toolCallName), args: "", at: typeof event.timestamp === "number" ? event.timestamp : undefined });
        return [];
      case "TOOL_CALL_ARGS": {
        const call = calls.get(String(event.toolCallId));
        if (call === undefined) loss({ type: event.type, reason: "arguments of a tool call that never started" });
        else call.args += String(event.delta);
        return [];
      }
      case "TOOL_CALL_END": {
        const call = calls.get(String(event.toolCallId));
        if (call === undefined) {
          loss({ type: event.type, reason: "the end of a tool call that never started" });
          return [];
        }
        let input: unknown = {};
        if (call.args.trim() !== "") {
          try {
            input = JSON.parse(call.args);
          } catch {
            input = call.args;
            loss({ type: event.type, field: "input", reason: "the arguments are not JSON; input is their text" });
          }
        }
        return [{ type: "tool-call", callId: String(event.toolCallId), name: call.name, input }];
      }
      case "TOOL_CALL_RESULT": {
        const callId = String(event.toolCallId);
        const call = calls.get(callId);
        if (call === undefined) {
          loss({ type: event.type, reason: "the result of a tool call that never started" });
          return [];
        }
        const failure = failures.get(callId);
        failures.delete(callId);
        const measured = call.at !== undefined && typeof event.timestamp === "number" ? Math.max(0, event.timestamp - call.at) : undefined;
        const ms = failure?.ms ?? measured ?? 0;
        return [{ type: "tool-result", callId, name: call.name, output: event.content, ...(failure ? { failure: failure.failure } : {}), ms }];
      }
      case "ACTIVITY_SNAPSHOT": {
        if (event.activityType !== AG_UI_CARD_ACTIVITY || !isCard(event.content)) {
          loss({ type: event.type, reason: `an activity that is not a ${AG_UI_CARD_ACTIVITY} card` });
          return [];
        }
        cards.set(event.content.id, event.content);
        return [{ type: "card", card: event.content }];
      }
      case "MESSAGES_SNAPSHOT": {
        const parts: Array<{ type: string; text?: string }> = [];
        const shown: RunCard[] = [];
        for (const m of Array.isArray(event.messages) ? (event.messages as unknown[]) : []) {
          if (isRecord(m) && m.role === "assistant" && typeof m.content === "string") parts.push({ type: "text", text: m.content });
          else if (isRecord(m) && m.role === "activity" && m.activityType === AG_UI_CARD_ACTIVITY && isCard(m.content)) {
            cards.set(m.content.id, m.content);
            shown.push(m.content);
          } else loss({ type: event.type, field: "messages", reason: `a message with role ${isRecord(m) ? String(m.role) : "(malformed)"} is not output of the run` });
        }
        return [{ type: "run-snapshot", parts, cards: shown }];
      }
      case "RUN_FINISHED": {
        lost(event, "usage", "left out until the counting of input tokens is decided (docs/RUN-EVENTS.md)");
        lost(event, "result", "a run has no result field");
        const outcome = isRecord(event.outcome) ? event.outcome : { type: "success" };
        if (outcome.type === "interrupt") {
          const out: RunEvent[] = [];
          for (const i of Array.isArray(outcome.interrupts) ? (outcome.interrupts as unknown[]) : []) {
            if (!isRecord(i) || !isText(i.id)) continue;
            const callId = isText(i.toolCallId) ? i.toolCallId : i.id;
            const card = [...cards.values()].reverse().find((c) => c.callId === callId);
            interrupts.set(i.id, { callId, card });
            if (card === undefined) loss({ type: event.type, field: "interrupts", reason: `interrupt ${i.id} names no card the stream showed` });
            else out.push({ type: "awaiting-user", callId, card });
            lost(i as AgUiEvent, "responseSchema", "a run's awaiting-user has no response schema yet");
          }
          return out;
        }
        return [{ type: "run-finish", runId: String(event.runId), finishReason: outcome.type === "cancelled" ? "cancelled" : "stop", usage: {}, steps }];
      }
      case "RUN_ERROR":
        return [
          { type: "error", error: { message: String(event.message), ...(isText(event.code) ? { code: event.code } : {}) }, recoverable: false },
          { type: "run-finish", runId, finishReason: "error", usage: {}, steps },
        ];
      case "CUSTOM": {
        const name = String(event.name);
        if (name === FAILURE && isRecord(event.value) && isText(event.value.toolCallId)) {
          failures.set(event.value.toolCallId, { failure: String(event.value.failure), ms: typeof event.value.ms === "number" ? event.value.ms : undefined });
          return [];
        }
        const type = name.startsWith(AG_UI_CUSTOM_PREFIX) ? name.slice(AG_UI_CUSTOM_PREFIX.length) : "";
        if (isRecord(event.value) && (CUSTOM_TYPES as readonly string[]).includes(type)) return [{ type, ...event.value } as unknown as RunEvent];
        if (isRecord(event.value) && name === RECOVERABLE_ERROR) return [{ type: "error", ...event.value } as unknown as RunEvent];
        loss({ type: event.type, field: "name", reason: `a custom event ${name} is not one of this protocol's` });
        return [];
      }
      default:
        loss({ type: event.type, reason: "an AG-UI event with no run event to become (state, patches, raw, sub-agents, chunk forms)" });
        return [];
    }
  };

  return { push: decode, end: () => [], resume };
}

/** A whole run's events as AG-UI events. */
export const encode = (events: Iterable<RunEvent>, options?: AgUiEncoderOptions): AgUiEvent[] => runMachine(createEncoder(options), events);
/** A whole AG-UI stream as run events. */
export const decode = (events: Iterable<AgUiEvent>, options?: AgUiDecoderOptions): RunEvent[] => runMachine(createDecoder(options), events);
