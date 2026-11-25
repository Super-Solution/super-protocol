/**
 * Run events: what an agent turn reports while it runs, wherever the loop lives.
 *
 * A turn that runs in the page and a turn that runs on a server report the same
 * events, so a chat UI can follow either one. The loop itself may be written in
 * any language; this module is the shape those events take as JSON, and the two
 * questions every follower has to answer the same way: did the turn end, and if
 * the stream stopped without ending it, what is it waiting for.
 *
 * The event names and fields are the ones super-chat's `RunEvent` uses, so a
 * super-chat client folds a conforming stream without a mapping layer. Payloads
 * the protocol does not own stay open: a content part is anything with a `type`,
 * a card spec anything with a `kind`, and tool input and output are not looked at.
 *
 * Transport is not prescribed. Over server-sent events, one event is one frame
 * whose `data` is the event as JSON.
 */
import { amount, bool, count, isObject, obj, oneOf, str, text, wrongType, type Fields } from "./check.js";
import { collector, didYouMean, type Add, type Issue } from "./issue.js";

/** Every run event type, in the order a simple turn tends to produce them. */
export const RUN_EVENT_TYPES = [
  "run-start",
  "run-snapshot",
  "context-built",
  "step-start",
  "text-delta",
  "reasoning-delta",
  "tool-call-input-delta",
  "tool-call",
  "awaiting-user",
  "user-responded",
  "tool-result",
  "card",
  "card-updated",
  "step-finish",
  "job-started",
  "job-status",
  "message",
  "metering",
  "usage",
  "run-finish",
  "error",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_MODES = ["stream", "sync", "background"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** Why a step or a run stopped. `cancelled` is the person stopping it: an outcome, not a fault. */
export const RUN_FINISH_REASONS = ["stop", "length", "tool-calls", "content-filter", "cancelled", "error", "unknown"] as const;
export type RunFinishReason = (typeof RUN_FINISH_REASONS)[number];

/** What a person can do with a card that waits for them. */
export const RUN_CARD_ACTION_TYPES = ["submit", "select", "confirm", "cancel", "dismiss"] as const;
export type RunCardActionType = (typeof RUN_CARD_ACTION_TYPES)[number];

export const RUN_JOB_STATUSES = ["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"] as const;
export type RunJobStatus = (typeof RUN_JOB_STATUSES)[number];

/** Token counts. Every field is optional: a provider reports what it knows. */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/** One piece of a message: text, reasoning, a tool call, a tool result, media. Only `type` is the protocol's. */
export type RunContentPart = { type: string } & Record<string, unknown>;

/** A card's payload. `kind` routes it to a renderer; the rest belongs to that kind. */
export type RunCardSpec = { kind: string } & Record<string, unknown>;

/** What the person answered on a card. */
export interface RunCardAction {
  cardId: string;
  /** The tool call the card belongs to, when it has one. */
  callId?: string;
  /** The card's kind. */
  kind: string;
  type: RunCardActionType;
  /** Selected option ids, form values, or nothing for confirm and cancel. */
  value?: unknown;
  /** When the person answered, in milliseconds since the epoch. */
  at: number;
}

export interface RunCard {
  id: string;
  spec: RunCardSpec;
  /** The payload was dropped from stored history. */
  expired?: boolean;
  /** The tool call this card belongs to; an answer finds its way back through it. */
  callId?: string;
  /** What the person answered, once they have. */
  action?: RunCardAction;
}

/** A provider-side background job. Fields beyond these two belong to the provider adapter. */
export type RunJobHandle = { provider: string; id: string } & Record<string, unknown>;

/**
 * Ordering, per tool call (correlate by `callId`, never by position):
 * `tool-call`, then its `card` / `awaiting-user` / `user-responded`, then exactly one `tool-result`,
 * failures included. All of a step's results arrive before the next `step-start`.
 */
export type RunEvent = RunEventBody & {
  /**
   * Optional, on any event: a counter that rises by one with each event of a run, so a follower can see that it missed
   * some. A producer that numbers its events numbers all of them, from 0.
   */
  seq?: number;
};

type RunEventBody =
  | {
      type: "run-start";
      runId: string;
      mode: RunMode;
      /** Optional: the conversation this run belongs to, for a follower that groups runs. Absent when the host keeps no thread. */
      threadId?: string;
    }
  /**
   * Everything the run has produced so far. It REPLACES what the follower holds: sent to a follower
   * that joins part-way or lost part of the stream. A card still waiting is announced again with
   * `awaiting-user` after it.
   */
  | { type: "run-snapshot"; parts: RunContentPart[]; cards: RunCard[]; usage?: RunUsage; steps?: number }
  /** What was sent to the model and why. Optional; inspectors read it. */
  | { type: "context-built"; trace: Record<string, unknown>; system: string; toolNames: string[] }
  | { type: "step-start"; step: number }
  /** `id`, when given, names the message the text belongs to; without one a follower uses `${runId}:${step}`. */
  | { type: "text-delta"; delta: string; id?: string }
  | { type: "reasoning-delta"; delta: string; id?: string }
  /** A preview of a tool call's arguments while the model is still writing them. Never stored. */
  | {
      type: "tool-call-input-delta";
      callId: string;
      name: string;
      partialInput: unknown;
      partialCard?: RunCardSpec;
      loading?: Record<string, unknown>;
    }
  | { type: "tool-call"; callId: string; name: string; input: unknown; repaired?: boolean; loading?: Record<string, unknown> }
  /** The run waits for the person to answer this card. */
  | { type: "awaiting-user"; callId: string; card: RunCard }
  | { type: "user-responded"; callId: string; action: RunCardAction }
  /** `failure` is set when the call did not produce a normal result; `ms` is how long it took. */
  | { type: "tool-result"; callId: string; name: string; output: unknown; failure?: string; ms: number }
  | { type: "card"; card: RunCard }
  | { type: "card-updated"; cardId: string; spec: RunCardSpec }
  | { type: "step-finish"; step: number; finishReason: RunFinishReason; usage?: RunUsage }
  | { type: "job-started"; handle: RunJobHandle }
  | { type: "job-status"; handle: RunJobHandle; status: RunJobStatus }
  | { type: "message"; parts: RunContentPart[] }
  /** One usage record per model call and one per run, for a ledger. Does not add to the live total. */
  | { type: "metering"; record: Record<string, unknown> }
  /** One model call's usage. The only event a follower adds up. */
  | { type: "usage"; usage: RunUsage }
  /** Ends the run. `usage` and `steps` are totals and replace what the follower added up. */
  | { type: "run-finish"; runId: string; finishReason: RunFinishReason; usage: RunUsage; steps: number }
  /** A run that failed sends this with `recoverable: false`, then `run-finish` with `finishReason: "error"`. */
  | { type: "error"; error: unknown; recoverable: boolean };

export type RunEventIssue = Issue;

const USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens"] as const;

function usage(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "must be an object");
  for (const field of USAGE_FIELDS) {
    if (v[field] !== undefined) amount(add, `${path}.${field}`, v[field]);
  }
}

function spec(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "must be an object");
  text(add, `${path}.kind`, v.kind);
}

function action(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "must be an object");
  text(add, `${path}.cardId`, v.cardId);
  if (v.callId !== undefined) text(add, `${path}.callId`, v.callId);
  text(add, `${path}.kind`, v.kind);
  oneOf(add, `${path}.type`, v.type, RUN_CARD_ACTION_TYPES);
  amount(add, `${path}.at`, v.at);
}

function card(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "must be an object");
  text(add, `${path}.id`, v.id);
  spec(add, `${path}.spec`, v.spec);
  if (v.expired !== undefined) bool(add, `${path}.expired`, v.expired);
  if (v.callId !== undefined) text(add, `${path}.callId`, v.callId);
  if (v.action !== undefined) action(add, `${path}.action`, v.action);
}

function parts(add: Add, path: string, v: unknown): void {
  if (!Array.isArray(v)) return wrongType(add, path, v, "must be an array");
  v.forEach((part: unknown, i) => {
    if (!isObject(part)) return wrongType(add, `${path}[${i}]`, part, "must be an object");
    text(add, `${path}[${i}].type`, part.type);
  });
}

function handle(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "must be an object");
  text(add, `${path}.provider`, v.provider);
  text(add, `${path}.id`, v.id);
}

function loading(add: Add, e: Fields): void {
  if (e.loading !== undefined) obj(add, "loading", e.loading);
}

/**
 * Returns every problem found; an empty array means the event is a valid run event.
 *
 * For whoever PRODUCES events: a server in any language checks what it sends. A follower should
 * not refuse a stream over an event type it does not know (see `isRunEventType`); later versions
 * add types.
 */
export function validateRunEvent(value: unknown): RunEventIssue[] {
  const { issues, add } = collector();
  if (!isObject(value)) {
    wrongType(add, "", value, "event must be an object");
    return issues;
  }
  const e = value;
  if (typeof e.type !== "string") {
    wrongType(add, "type", e.type, "must be a string");
    return issues;
  }
  switch (e.type) {
    case "run-start":
      text(add, "runId", e.runId);
      oneOf(add, "mode", e.mode, RUN_MODES);
      if (e.threadId !== undefined) text(add, "threadId", e.threadId);
      break;
    case "run-snapshot":
      parts(add, "parts", e.parts);
      if (!Array.isArray(e.cards)) wrongType(add, "cards", e.cards, "must be an array");
      else e.cards.forEach((c: unknown, i) => card(add, `cards[${i}]`, c));
      if (e.usage !== undefined) usage(add, "usage", e.usage);
      if (e.steps !== undefined) count(add, "steps", e.steps);
      break;
    case "context-built":
      obj(add, "trace", e.trace);
      str(add, "system", e.system);
      if (!Array.isArray(e.toolNames)) wrongType(add, "toolNames", e.toolNames, "must be an array");
      else e.toolNames.forEach((name: unknown, i) => str(add, `toolNames[${i}]`, name));
      break;
    case "step-start":
      count(add, "step", e.step);
      break;
    case "text-delta":
    case "reasoning-delta":
      str(add, "delta", e.delta);
      if (e.id !== undefined) text(add, "id", e.id);
      break;
    case "tool-call-input-delta":
      text(add, "callId", e.callId);
      text(add, "name", e.name);
      if (e.partialCard !== undefined) spec(add, "partialCard", e.partialCard);
      loading(add, e);
      break;
    case "tool-call":
      text(add, "callId", e.callId);
      text(add, "name", e.name);
      if (e.repaired !== undefined) bool(add, "repaired", e.repaired);
      loading(add, e);
      break;
    case "awaiting-user":
      text(add, "callId", e.callId);
      card(add, "card", e.card);
      break;
    case "user-responded":
      text(add, "callId", e.callId);
      action(add, "action", e.action);
      break;
    case "tool-result":
      text(add, "callId", e.callId);
      text(add, "name", e.name);
      if (e.failure !== undefined) str(add, "failure", e.failure);
      amount(add, "ms", e.ms);
      break;
    case "card":
      card(add, "card", e.card);
      break;
    case "card-updated":
      text(add, "cardId", e.cardId);
      spec(add, "spec", e.spec);
      break;
    case "step-finish":
      count(add, "step", e.step);
      oneOf(add, "finishReason", e.finishReason, RUN_FINISH_REASONS);
      if (e.usage !== undefined) usage(add, "usage", e.usage);
      break;
    case "job-started":
      handle(add, "handle", e.handle);
      break;
    case "job-status":
      handle(add, "handle", e.handle);
      oneOf(add, "status", e.status, RUN_JOB_STATUSES);
      break;
    case "message":
      parts(add, "parts", e.parts);
      break;
    case "metering":
      obj(add, "record", e.record);
      break;
    case "usage":
      usage(add, "usage", e.usage);
      break;
    case "run-finish":
      text(add, "runId", e.runId);
      oneOf(add, "finishReason", e.finishReason, RUN_FINISH_REASONS);
      usage(add, "usage", e.usage);
      count(add, "steps", e.steps);
      break;
    case "error":
      bool(add, "recoverable", e.recoverable);
      break;
    default:
      add("type", "enum", "unknown run event type", didYouMean(e.type, RUN_EVENT_TYPES));
      return issues;
  }
  if (e.seq !== undefined) count(add, "seq", e.seq);
  return issues;
}

/** Whether `type` is a run event type this version knows. A follower skips the ones it does not. */
export function isRunEventType(type: unknown): type is RunEventType {
  return typeof type === "string" && (RUN_EVENT_TYPES as readonly string[]).includes(type);
}

/** Whether the event ends its run. Only `run-finish` does: an `error` event is followed by one. */
export function isRunTerminalEvent(event: { type: string }): boolean {
  return event.type === "run-finish";
}

/**
 * - `finished`: the run ended (its last word was `run-finish`).
 * - `awaiting-user`: the run is suspended on a card the person has not answered.
 * - `interrupted`: the run was still working when the stream stopped. It may well be running
 *   still: follow it again rather than report a failure.
 * - `empty`: no run event at all, so there was nothing to follow.
 */
export type RunStreamOutcome = "empty" | "finished" | "awaiting-user" | "interrupted";

/**
 * What a stream that has stopped says about its run. Call it when the connection closes, with
 * every event the stream delivered, in order.
 *
 * A closed connection is not the end of a run. A run that waits for approval closes its stream
 * and stays suspended for as long as the person takes, and a dropped connection leaves the run
 * working on the server. Only `run-finish` ends it.
 *
 * Values that are not run events of a known type are skipped. `run-start` and `run-snapshot`
 * start the picture over, so the events of an earlier run or from before a reconnect do not
 * leak into the answer.
 */
export function runStreamOutcome(events: readonly unknown[]): RunStreamOutcome {
  let seen = false;
  let finished = false;
  const waiting = new Set<string>();
  for (const event of events) {
    if (!isObject(event) || !isRunEventType(event.type)) continue;
    seen = true;
    const callId = typeof event.callId === "string" ? event.callId : "";
    switch (event.type) {
      case "run-start":
      case "run-snapshot":
        finished = false;
        waiting.clear();
        break;
      case "awaiting-user":
        finished = false;
        waiting.add(callId);
        break;
      case "user-responded":
      case "tool-result":
        waiting.delete(callId);
        break;
      case "run-finish":
        finished = true;
        waiting.clear();
        break;
      default:
    }
  }
  if (!seen) return "empty";
  if (finished) return "finished";
  return waiting.size > 0 ? "awaiting-user" : "interrupted";
}
