/**
 * Run events <-> the AI SDK's UI message stream (DRAFT: not stable; see docs/INTEROP.md for the table and what is lost).
 *
 * `createEncoder` turns a run's events into the chunks a UI built on the AI SDK (`useChat`) reads; `createDecoder` turns
 * the chunks an AI SDK backend streams into run events, so a client built on this protocol can sit in front of someone
 * else's AI SDK backend. State machines, no I/O, no import of `ai`: the chunk shapes here are structural, and
 * `conformance/interop-ai-sdk.v0.json` is checked against `ai`'s own `uiMessageChunkSchema` and `readUIMessageStream` by
 * `scripts/export-interop-ai-sdk.mjs`.
 *
 * The AI SDK moves fast (`needsApproval` is deprecated, steering messages are experimental): this module follows the
 * stream marked `x-vercel-ai-ui-message-stream: v1` and nothing else, and says so in `UI_MESSAGE_STREAM_HEADERS`.
 *
 * What the state is for:
 * - A text part is opened (`text-start`), filled and closed (`text-end`); a run's `text-delta` has no start or end. The
 *   encoder opens at the first delta and closes before the next tool call, step end, card or the end of the run.
 * - Every part has an id; a run's delta usually has none, so the id is `${runId}:${step}` (RUN-EVENTS.md).
 * - Tools are `dynamic`: the protocol does not know a host's tool types, and the AI SDK's `dynamic-tool` part is the one
 *   that does not need them.
 */
import type { RunCard, RunCardAction, RunEvent } from "../run.js";
import { errorMessage, isRecord, isText, runMachine, type AdapterOptions, type StreamMachine } from "./types.js";

/** A UI message chunk, structurally: a `type` and whatever fields that type has. */
export type UiMessageChunk = { type: string } & Record<string, unknown>;

/** The headers of a response that carries these chunks as server-sent events. */
export const UI_MESSAGE_STREAM_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
};

/** The last frame of the stream: `data: [DONE]`. */
export const UI_MESSAGE_STREAM_DONE = "data: [DONE]\n\n";

/** One chunk as a server-sent event. */
export const sseFrame = (chunk: UiMessageChunk): string => `data: ${JSON.stringify(chunk)}\n\n`;

/** Chunks as the body of a response: one frame each, then `[DONE]`. */
export const toSse = (chunks: Iterable<UiMessageChunk>): string => [...chunks].map(sseFrame).join("") + UI_MESSAGE_STREAM_DONE;

/** The kind of the card a decoder makes of an AI SDK tool approval request: the protocol has no confirm card of its own. */
export const AI_SDK_APPROVAL_CARD_KIND = "ai-sdk.tool-approval";

export interface AiSdkEncoderOptions extends AdapterOptions {
  /** Whether a card that waits is a yes/no question, sent as an approval request. Default: no card is. */
  isConfirm?: (card: RunCard) => boolean;
}

export interface AiSdkDecoderOptions extends AdapterOptions {
  /** The run id; an AI SDK `start` chunk may carry only a message id, and a run has no message id of its own. */
  runId?: string;
  /** When a person's approval is read; default `Date.now`. A test passes a fixed clock. */
  now?: () => number;
}

// Run events the UI message stream has no chunk for. Each travels as a `data-super-<type>` chunk with the rest of the
// event as its data, so nothing in them is lost and the decoder gives the event back.
const DATA_TYPES = ["run-snapshot", "context-built", "metering", "job-started", "job-status", "usage"] as const;
const SOURCE_PARTS: Readonly<Record<string, readonly string[]>> = {
  "source-url": ["sourceId", "url", "title"],
  "source-document": ["sourceId", "mediaType", "title", "filename"],
  file: ["url", "mediaType"],
};
const REQUIRED_SOURCE_FIELDS: Readonly<Record<string, readonly string[]>> = { "source-url": ["sourceId", "url"], "source-document": ["sourceId", "mediaType", "title"], file: ["url", "mediaType"] };
const FINISH_TO_AI_SDK: Readonly<Record<string, string>> = { stop: "stop", length: "length", "tool-calls": "tool-calls", "content-filter": "content-filter", error: "error", unknown: "other" };
const FINISH_FROM_AI_SDK: Readonly<Record<string, string>> = { stop: "stop", length: "length", "tool-calls": "tool-calls", "content-filter": "content-filter", error: "error", other: "unknown" };

const without = (event: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) if (!keys.includes(key)) rest[key] = value;
  return rest;
};
const pick = (from: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
  return out;
};

export function createEncoder(options: AiSdkEncoderOptions = {}): StreamMachine<RunEvent, UiMessageChunk> {
  const loss = options.onLoss ?? (() => {});
  const isConfirm = options.isConfirm ?? (() => false);
  let runId = "run";
  let step = 0;
  let text: string | null = null;
  let reasoning: string | null = null;
  let finished = false;
  const started = new Set<string>();
  const cards = new Map<string, RunCard>();
  const waiting = new Map<string, { approval: boolean }>();
  const partId = () => `${runId}:${step}`;

  const closeParts = (): UiMessageChunk[] => {
    const out: UiMessageChunk[] = [];
    if (reasoning !== null) out.push({ type: "reasoning-end", id: reasoning });
    if (text !== null) out.push({ type: "text-end", id: text });
    reasoning = text = null;
    return out;
  };
  const lost = (event: RunEvent, field: string, why: string) => {
    if ((event as Record<string, unknown>)[field] !== undefined) loss({ type: event.type, field, reason: why });
  };
  const data = (name: string, value: unknown, extra: Record<string, unknown> = {}): UiMessageChunk => ({ type: `data-super-${name}`, ...extra, data: value });
  const showCard = (card: RunCard): UiMessageChunk => data("card", card, { id: card.id });

  const encode = (event: RunEvent): UiMessageChunk[] => {
    if (!isRecord(event) || typeof event.type !== "string") {
      loss({ type: String((event as { type?: unknown } | null)?.type), reason: "not a run event" });
      return [];
    }
    if (finished) {
      loss({ type: event.type, reason: "after the run's last chunk" });
      return [];
    }
    lost(event, "seq", "the UI message stream carries no sequence number");
    switch (event.type) {
      case "run-start":
        runId = event.runId;
        if (event.mode !== "stream") loss({ type: event.type, field: "mode", reason: "the UI message stream has no run mode; a decoded run is a stream" });
        lost(event, "threadId", "a chat's id is on the request, not in the stream");
        lost(event, "protocol", "the UI message stream has its own version header, not this one");
        return [{ type: "start", messageId: runId }];
      case "step-start":
        step = event.step;
        return [...closeParts(), { type: "start-step" }];
      case "step-finish":
        lost(event, "finishReason", "finish-step has no fields");
        lost(event, "usage", "finish-step has no fields");
        return [...closeParts(), { type: "finish-step" }];
      case "text-delta": {
        if (event.delta === "") return [];
        const id = event.id ?? partId();
        const out: UiMessageChunk[] = [];
        if (reasoning !== null || (text !== null && text !== id)) out.push(...closeParts());
        if (text === null) {
          out.push({ type: "text-start", id });
          text = id;
        }
        out.push({ type: "text-delta", id, delta: event.delta });
        return out;
      }
      case "reasoning-delta": {
        if (event.delta === "") return [];
        const id = event.id ?? `${partId()}:reasoning`;
        const out: UiMessageChunk[] = [];
        if (text !== null || (reasoning !== null && reasoning !== id)) out.push(...closeParts());
        if (reasoning === null) {
          out.push({ type: "reasoning-start", id });
          reasoning = id;
        }
        out.push({ type: "reasoning-delta", id, delta: event.delta });
        return out;
      }
      case "tool-call-input-delta": {
        const out: UiMessageChunk[] = [];
        if (!started.has(event.callId)) {
          started.add(event.callId);
          out.push(...closeParts(), { type: "tool-input-start", toolCallId: event.callId, toolName: event.name, dynamic: true });
        }
        // `inputTextDelta` is text that adds up to the arguments; a preview here is the whole object so far, and a later
        // preview replaces it. Re-serialised it would not add up, so the preview is left out and the call comes whole.
        loss({ type: event.type, field: "partialInput", reason: "a preview object is not a text delta; the call is sent whole at tool-call" });
        lost(event, "partialCard", "the UI message stream has no partial card");
        return out;
      }
      case "tool-call":
        lost(event, "repaired", "the UI message stream has no field for it");
        lost(event, "loading", "the UI message stream has no field for it");
        return [...closeParts(), { type: "tool-input-available", toolCallId: event.callId, toolName: event.name, input: event.input ?? {}, dynamic: true }];
      case "tool-result":
        lost(event, "ms", "the UI message stream has no duration");
        if (event.failure !== undefined) {
          lost(event, "output", "a failed result has only errorText");
          return [{ type: "tool-output-error", toolCallId: event.callId, errorText: event.failure, dynamic: true }];
        }
        return [{ type: "tool-output-available", toolCallId: event.callId, output: event.output ?? null, dynamic: true }];
      case "card":
        cards.set(event.card.id, event.card);
        return [...closeParts(), showCard(event.card)];
      case "card-updated": {
        const card = { ...(cards.get(event.cardId) ?? { id: event.cardId }), spec: event.spec } as RunCard;
        cards.set(card.id, card);
        return [...closeParts(), showCard(card)];
      }
      case "awaiting-user": {
        cards.set(event.card.id, event.card);
        const approval = isConfirm(event.card);
        waiting.set(event.callId, { approval });
        const out = [...closeParts(), showCard(event.card)];
        // A yes/no card is an approval request; any other card is announced as waiting by a data part, since the AI SDK
        // has no word for a tool call that waits for a form.
        out.push(approval ? { type: "tool-approval-request", approvalId: event.callId, toolCallId: event.callId } : data("awaiting-user", { callId: event.callId, cardId: event.card.id }));
        return out;
      }
      case "user-responded": {
        const approval = waiting.get(event.callId)?.approval === true;
        waiting.delete(event.callId);
        if (approval) {
          if (event.action.value !== undefined) loss({ type: event.type, field: "action.value", reason: "an approval answer is only yes or no" });
          return [{ type: "tool-approval-response", approvalId: event.callId, approved: event.action.type === "confirm" }];
        }
        return [data("user-responded", { callId: event.callId, action: event.action })];
      }
      case "message": {
        const out: UiMessageChunk[] = [];
        const rest: unknown[] = [];
        for (const part of event.parts) {
          const fields = SOURCE_PARTS[part.type];
          if (fields !== undefined && REQUIRED_SOURCE_FIELDS[part.type]!.every((k) => typeof part[k] === "string")) out.push({ type: part.type, ...pick(part, fields) });
          else rest.push(part);
        }
        if (rest.length > 0) out.push(data("message", { parts: rest }));
        return out.length > 0 ? [...closeParts(), ...out] : [];
      }
      case "error": {
        if (event.recoverable) return [data("error", without(event, "type"))];
        if (isRecord(event.error) && Object.keys(event.error).some((k) => k !== "message")) lost(event, "error", "an error chunk has only a text; the code and any other field of the error are not carried");
        return [...closeParts(), { type: "error", errorText: errorMessage(event.error) }];
      }
      case "run-finish": {
        finished = true;
        const out = closeParts();
        if (event.finishReason === "cancelled") {
          loss({ type: event.type, field: "usage", reason: "an abort chunk has only a reason" });
          return [...out, { type: "abort" }];
        }
        return [...out, { type: "finish", finishReason: FINISH_TO_AI_SDK[event.finishReason] ?? "other", messageMetadata: { super: { usage: event.usage, steps: event.steps } } }];
      }
      default:
        if ((DATA_TYPES as readonly string[]).includes(event.type)) {
          const transient = event.type === "usage" ? { transient: true } : event.type === "run-snapshot" ? { id: "run-snapshot" } : {};
          return [data(event.type, without(event as Record<string, unknown>, "type"), transient)];
        }
        loss({ type: String((event as { type: unknown }).type), reason: "not a run event type this version knows" });
        return [];
    }
  };

  return {
    push: encode,
    end() {
      const out = closeParts();
      if (!finished && waiting.size > 0) {
        // A card is waiting: the message ends with its tool calls unanswered, which is what finishReason "tool-calls" says.
        out.push({ type: "finish", finishReason: "tool-calls" });
        finished = true;
      }
      return out;
    },
  };
}

export function createDecoder(options: AiSdkDecoderOptions = {}): StreamMachine<UiMessageChunk, RunEvent> {
  const loss = options.onLoss ?? (() => {});
  const now = options.now ?? Date.now;
  let runId = options.runId ?? "";
  let step = 0;
  let steps = 0;
  let errored = false;
  const names = new Map<string, string>();
  const approvals = new Map<string, { callId: string; card: RunCard }>();
  const cards = new Map<string, RunCard>();
  const waiting = new Set<string>();
  const synthesized = (id: unknown) => id === `${runId}:${step}`;
  const isCard = (v: unknown): v is RunCard => isRecord(v) && isText(v.id) && isRecord(v.spec) && isText(v.spec.kind);
  const result = (callId: string, failure: string | undefined, output: unknown): RunEvent[] => {
    const name = names.get(callId);
    if (name === undefined) {
      loss({ type: "tool-output", reason: `the result of tool call ${callId}, which was never announced` });
      return [];
    }
    return [{ type: "tool-result", callId, name, output, ...(failure === undefined ? {} : { failure }), ms: 0 }];
  };

  const decode = (chunk: UiMessageChunk): RunEvent[] => {
    if (!isRecord(chunk) || typeof chunk.type !== "string") {
      loss({ type: String((chunk as { type?: unknown } | null)?.type), reason: "not a UI message chunk" });
      return [];
    }
    switch (chunk.type) {
      case "start": {
        if (options.runId === undefined) runId = isText(chunk.messageId) ? chunk.messageId : runId;
        if (runId === "") throw new RangeError("an AI SDK stream carries no run id: pass options.runId, or a start chunk with a messageId");
        step = 0;
        steps = 0;
        if (chunk.messageMetadata !== undefined) loss({ type: chunk.type, field: "messageMetadata", reason: "a run's run-start has no metadata" });
        return [{ type: "run-start", runId, mode: "stream" }];
      }
      case "start-step":
        step = steps;
        steps += 1;
        return [{ type: "step-start", step }];
      case "finish-step":
        return [{ type: "step-finish", step, finishReason: "unknown" }];
      case "text-start":
      case "text-end":
      case "reasoning-start":
      case "reasoning-end":
        return [];
      case "text-delta":
        return [{ type: "text-delta", delta: String(chunk.delta), ...(isText(chunk.id) && !synthesized(chunk.id) ? { id: chunk.id } : {}) }];
      case "reasoning-delta":
        return [{ type: "reasoning-delta", delta: String(chunk.delta), ...(isText(chunk.id) && chunk.id !== `${runId}:${step}:reasoning` ? { id: chunk.id } : {}) }];
      case "tool-input-start":
        names.set(String(chunk.toolCallId), String(chunk.toolName));
        return [];
      case "tool-input-delta":
        loss({ type: chunk.type, reason: "a piece of the arguments as text; the call is reported at tool-input-available" });
        return [];
      case "tool-input-available":
        names.set(String(chunk.toolCallId), String(chunk.toolName));
        return [{ type: "tool-call", callId: String(chunk.toolCallId), name: String(chunk.toolName), input: chunk.input }];
      case "tool-input-error":
        names.set(String(chunk.toolCallId), String(chunk.toolName));
        return [{ type: "tool-call", callId: String(chunk.toolCallId), name: String(chunk.toolName), input: chunk.input }, ...result(String(chunk.toolCallId), String(chunk.errorText), null)];
      case "tool-output-available":
        if (chunk.preliminary === true) {
          loss({ type: chunk.type, reason: "a preliminary output; a run's tool-result is the final one" });
          return [];
        }
        return result(String(chunk.toolCallId), undefined, chunk.output);
      case "tool-output-error":
        return result(String(chunk.toolCallId), String(chunk.errorText), null);
      case "tool-output-denied":
        return result(String(chunk.toolCallId), "the tool call was denied", null);
      case "tool-approval-request": {
        const callId = String(chunk.toolCallId);
        const approvalId = String(chunk.approvalId);
        // The card the stream showed for this call, if it showed one; otherwise the protocol has no card for a yes/no.
        const shown = [...cards.values()].reverse().find((c) => c.callId === callId);
        const card: RunCard = shown ?? { id: approvalId, callId, spec: { kind: AI_SDK_APPROVAL_CARD_KIND, approvalId, toolCallId: callId, ...(isText(chunk.reason) ? { reason: chunk.reason } : {}) } };
        approvals.set(approvalId, { callId, card });
        waiting.add(callId);
        return [{ type: "awaiting-user", callId, card }];
      }
      case "tool-approval-response": {
        const open = approvals.get(String(chunk.approvalId));
        if (open === undefined) {
          loss({ type: chunk.type, reason: `an answer to approval ${String(chunk.approvalId)}, which was never requested` });
          return [];
        }
        approvals.delete(String(chunk.approvalId));
        waiting.delete(open.callId);
        const action: RunCardAction = { cardId: open.card.id, callId: open.callId, kind: open.card.spec.kind, type: chunk.approved === true ? "confirm" : "cancel", at: now() };
        return [{ type: "user-responded", callId: open.callId, action }];
      }
      case "source-url":
      case "source-document":
      case "file": {
        const fields = SOURCE_PARTS[chunk.type]!;
        return [{ type: "message", parts: [{ type: chunk.type, ...pick(chunk, fields) }] }];
      }
      case "error":
        errored = true;
        return [{ type: "error", error: { message: String(chunk.errorText) }, recoverable: false }];
      case "finish": {
        // A message that finishes with "tool-calls" while a card waits is a run that is suspended, not one that ended.
        if (waiting.size > 0 && chunk.finishReason === "tool-calls") return [];
        const meta = isRecord(chunk.messageMetadata) && isRecord(chunk.messageMetadata.super) ? chunk.messageMetadata.super : {};
        const usage = isRecord(meta.usage) ? meta.usage : {};
        const total = typeof meta.steps === "number" && Number.isInteger(meta.steps) && meta.steps >= 0 ? meta.steps : steps;
        const reason = typeof chunk.finishReason === "string" ? FINISH_FROM_AI_SDK[chunk.finishReason] ?? "unknown" : errored ? "error" : "unknown";
        return [{ type: "run-finish", runId, finishReason: reason as "stop", usage, steps: total } as RunEvent];
      }
      case "abort":
        return [{ type: "run-finish", runId, finishReason: "cancelled", usage: {}, steps }];
      default: {
        if (chunk.type.startsWith("data-super-") && "data" in chunk) {
          const name = chunk.type.slice("data-super-".length);
          const value = chunk.data;
          if (name === "card" && isCard(value)) {
            cards.set(value.id, value);
            return [{ type: "card", card: value }];
          }
          if (name === "awaiting-user" && isRecord(value) && isText(value.callId)) {
            const card = cards.get(String(value.cardId));
            if (card === undefined) {
              loss({ type: chunk.type, reason: `the card ${String(value.cardId)} was never shown` });
              return [];
            }
            waiting.add(value.callId);
            return [{ type: "awaiting-user", callId: value.callId, card }];
          }
          if (name === "user-responded" && isRecord(value)) {
            if (isText(value.callId)) waiting.delete(value.callId);
            return [{ type: "user-responded", ...value } as unknown as RunEvent];
          }
          if (name === "message" && isRecord(value)) return [{ type: "message", ...value } as unknown as RunEvent];
          if (name === "error" && isRecord(value)) return [{ type: "error", ...value } as unknown as RunEvent];
          if ((DATA_TYPES as readonly string[]).includes(name) && isRecord(value)) return [{ type: name, ...value } as unknown as RunEvent];
        }
        loss({ type: chunk.type, reason: "a chunk with no run event to become (message metadata, custom, steering, other data parts)" });
        return [];
      }
    }
  };

  return { push: decode, end: () => [] };
}

/** A whole run's events as UI message chunks. */
export const encode = (events: Iterable<RunEvent>, options?: AiSdkEncoderOptions): UiMessageChunk[] => runMachine(createEncoder(options), events);
/** A whole UI message stream as run events. */
export const decode = (chunks: Iterable<UiMessageChunk>, options?: AiSdkDecoderOptions): RunEvent[] => runMachine(createDecoder(options), chunks);
