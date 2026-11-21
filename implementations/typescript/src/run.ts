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
import type { ManifestIssue } from "./plugin.js";

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
export type RunEvent =
  | { type: "run-start"; runId: string; mode: RunMode }
  /**
   * Everything the run has produced so far. It REPLACES what the follower holds: sent to a follower
   * that joins part-way or lost part of the stream. A card still waiting is announced again with
   * `awaiting-user` after it.
   */
  | { type: "run-snapshot"; parts: RunContentPart[]; cards: RunCard[]; usage?: RunUsage; steps?: number }
  /** What was sent to the model and why. Optional; inspectors read it. */
  | { type: "context-built"; trace: Record<string, unknown>; system: string; toolNames: string[] }
  | { type: "step-start"; step: number }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
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

export type RunEventIssue = ManifestIssue;

const USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens"] as const;

type Add = (path: string, message: string) => void;
type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isAmount = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;

function text(add: Add, path: string, v: unknown): void {
  if (typeof v !== "string" || v === "") add(path, "must be a non-empty string");
}
function oneOf(add: Add, path: string, v: unknown, allowed: readonly string[]): void {
  if (typeof v !== "string" || !allowed.includes(v)) add(path, `must be one of ${allowed.join(", ")}`);
}
function count(add: Add, path: string, v: unknown): void {
  if (!isCount(v)) add(path, "must be a non-negative integer");
}

function usage(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return add(path, "must be an object");
  for (const field of USAGE_FIELDS) {
    if (v[field] !== undefined && !isAmount(v[field])) add(`${path}.${field}`, "must be a non-negative number");
  }
}

function spec(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return add(path, "must be an object");
  text(add, `${path}.kind`, v.kind);
}

function action(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return add(path, "must be an object");
  text(add, `${path}.cardId`, v.cardId);
  if (v.callId !== undefined) text(add, `${path}.callId`, v.callId);
  text(add, `${path}.kind`, v.kind);
  oneOf(add, `${path}.type`, v.type, RUN_CARD_ACTION_TYPES);
  if (!isAmount(v.at)) add(`${path}.at`, "must be a non-negative number");
}

function card(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return add(path, "must be an object");
  text(add, `${path}.id`, v.id);
  spec(add, `${path}.spec`, v.spec);
  if (v.expired !== undefined && typeof v.expired !== "boolean") add(`${path}.expired`, "must be a boolean");
  if (v.callId !== undefined) text(add, `${path}.callId`, v.callId);
  if (v.action !== undefined) action(add, `${path}.action`, v.action);
}

function parts(add: Add, path: string, v: unknown): void {
  if (!Array.isArray(v)) return add(path, "must be an array");
  v.forEach((part: unknown, i) => {
    if (!isObject(part)) return add(`${path}[${i}]`, "must be an object");
    text(add, `${path}[${i}].type`, part.type);
  });
}

function handle(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return add(path, "must be an object");
  text(add, `${path}.provider`, v.provider);
  text(add, `${path}.id`, v.id);
}

function loading(add: Add, e: Fields): void {
  if (e.loading !== undefined && !isObject(e.loading)) add("loading", "must be an object");
}

/**
 * Returns every problem found; an empty array means the event is a valid run event.
 *
 * For whoever PRODUCES events: a server in any language checks what it sends. A follower should
 * not refuse a stream over an event type it does not know (see `isRunEventType`); later versions
 * add types.
 */
export function validateRunEvent(value: unknown): RunEventIssue[] {
  const issues: RunEventIssue[] = [];
  const add: Add = (path, message) => issues.push({ path, message });
  if (!isObject(value)) return [{ path: "", message: "event must be an object" }];
  const e = value;
  if (typeof e.type !== "string") return [{ path: "type", message: "must be a string" }];
  switch (e.type) {
    case "run-start":
      text(add, "runId", e.runId);
      oneOf(add, "mode", e.mode, RUN_MODES);
      break;
    case "run-snapshot":
      parts(add, "parts", e.parts);
      if (!Array.isArray(e.cards)) add("cards", "must be an array");
      else e.cards.forEach((c: unknown, i) => card(add, `cards[${i}]`, c));
      if (e.usage !== undefined) usage(add, "usage", e.usage);
      if (e.steps !== undefined) count(add, "steps", e.steps);
      break;
    case "context-built":
      if (!isObject(e.trace)) add("trace", "must be an object");
      if (typeof e.system !== "string") add("system", "must be a string");
      if (!Array.isArray(e.toolNames)) add("toolNames", "must be an array");
      else
        e.toolNames.forEach((name: unknown, i) => {
          if (typeof name !== "string") add(`toolNames[${i}]`, "must be a string");
        });
      break;
    case "step-start":
      count(add, "step", e.step);
      break;
    case "text-delta":
    case "reasoning-delta":
      if (typeof e.delta !== "string") add("delta", "must be a string");
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
      if (e.repaired !== undefined && typeof e.repaired !== "boolean") add("repaired", "must be a boolean");
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
      if (e.failure !== undefined && typeof e.failure !== "string") add("failure", "must be a string");
      if (!isAmount(e.ms)) add("ms", "must be a non-negative number");
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
      if (!isObject(e.record)) add("record", "must be an object");
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
      if (typeof e.recoverable !== "boolean") add("recoverable", "must be a boolean");
      break;
    default:
      add("type", "unknown run event type");
  }
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
