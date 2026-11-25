import { bool, count, isObject, obj, oneOf, str, text, wrongType } from "./check.js";
import { collector, didYouMean, jsonType, type Add, type Issue } from "./issue.js";

/**
 * The inference-gateway abstraction. super-chat talks to this interface, not to
 * a vendor; the default implementation binds to Super Router, and any other
 * gateway can implement it. Wire shapes match the Super Router HTTP API.
 */

/** One part of a multi-part user message. Plain text messages keep using a `content` string. */
export type InferenceContentPart =
  | { type: "text"; text: string }
  /** An `https:` URL or a `data:image/(png|jpeg|gif|webp);base64,` URL. */
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" };

/** A tool call the model made. `arguments` is the JSON text exactly as the model wrote it. */
export interface InferenceToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * A message on the wire. The first form is the original one and stays valid;
 * the others are only sent by a caller that uses tools or images.
 */
export type InferenceMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "user"; content: InferenceContentPart[] }
  | { role: "assistant"; content?: string; tool_calls: InferenceToolCall[] }
  /** The result of the tool call `tool_call_id`, which an earlier assistant message must have made. */
  | { role: "tool"; tool_call_id: string; content: string; is_error?: boolean };

/** A tool the model may call. */
export interface InferenceTool {
  /** Letters, digits, `_` and `-`; at most 64 characters. */
  name: string;
  description?: string;
  /** JSON Schema of the arguments; must describe an object. */
  input_schema: Record<string, unknown>;
}

export type InferenceToolChoice = "auto" | "none" | "required" | { name: string };

/** Why the model stopped. Absent on gateways that do not report it. */
export type InferenceFinishReason = "stop" | "length" | "tool_calls";

export interface Usage {
  input: number;
  cached: number;
  cache_write: number;
  output: number;
  images?: number;
  video_ms?: number;
  audio_ms?: number;
  tasks?: number;
}

export interface InferenceRequest {
  /** The service (the thing being sold), not a raw model name. */
  service: string;
  service_version?: number;
  customer_id: string;
  messages: InferenceMessage[];
  /** Absent means the request declares no tools. A gateway that cannot call tools must refuse, not ignore, them. */
  tools?: InferenceTool[];
  tool_choice?: InferenceToolChoice;
  max_output_tokens?: number;
  timeout_ms?: number;
}

export type ExecutionStatus = "succeeded" | "failed" | "cancelled" | "unknown";

/** What the usage of a finished request is known to be. `meters` is present once the usage is confirmed. */
export interface InferenceUsage {
  status: string;
  meters?: Usage;
}

export type StreamEvent =
  | { type: "request.started"; request_id: string; sequence: number; service_version: number }
  | { type: "output.delta"; request_id: string; sequence: number; text: string }
  /** Part of a tool call's arguments. `id` and `name` arrive on the first delta of each `index`. */
  | { type: "output.tool_call.delta"; request_id: string; sequence: number; index: number; id?: string; name?: string; arguments_delta: string }
  /** A whole tool call. Sent only after the model finished normally, so a cut-off call is never reported as complete. */
  | { type: "output.tool_call.completed"; request_id: string; sequence: number; index: number; id: string; name: string; arguments: string }
  | { type: "request.completed"; request_id: string; sequence: number; execution_status: ExecutionStatus; billing_status: string; finish_reason?: InferenceFinishReason; usage?: InferenceUsage }
  | { type: "request.failed"; request_id: string; sequence: number; execution_status?: ExecutionStatus; billing_status?: string; error?: { code: string }; usage?: InferenceUsage }
  | { type: "request.replayed"; request_id: string; sequence: number };

export interface InferenceResult {
  id: string;
  execution_status: ExecutionStatus;
  billing_status: string;
  /** Absent when the request is read back later: the router does not store completions. */
  output?: { role: "assistant"; content: string; tool_calls?: InferenceToolCall[] };
  finish_reason?: InferenceFinishReason;
  usage: InferenceUsage;
}

export interface InferenceGateway {
  /** `idempotencyKey` makes a retry safe: the same key never bills twice. */
  infer(request: InferenceRequest, idempotencyKey: string): Promise<InferenceResult>;
  stream(request: InferenceRequest, idempotencyKey: string, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

export class GatewayError extends Error {
  constructor(
    public code: string,
    public status?: number,
    public requestId?: string,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}

export function isTerminalEvent(event: Pick<StreamEvent, "type">): boolean {
  return event.type === "request.completed" || event.type === "request.failed" || event.type === "request.replayed";
}

/** Concatenates the text of a stream; throws when the stream ends without a terminal event. */
export async function collectText(events: AsyncIterable<StreamEvent>): Promise<string> {
  let text = "";
  let terminal = false;
  for await (const event of events) {
    if (event.type === "output.delta") text += event.text;
    if (isTerminalEvent(event)) terminal = true;
  }
  if (!terminal) throw new GatewayError("stream_interrupted");
  return text;
}

/** Parses SSE across arbitrary chunk and CRLF boundaries. Never logs content. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, maxFrameBytes = 2_000_000): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > maxFrameBytes) throw new GatewayError("stream_frame_too_large");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ---- validators -------------------------------------------------------------------------------
// What a gateway accepts and what it streams back, as pure functions. Like the other validators in this package
// they return every problem found and an empty list means the value is valid; unknown extra keys are not refused.

export const INFERENCE_ROLES = ["system", "user", "assistant", "tool"] as const;
export const INFERENCE_FINISH_REASONS: readonly InferenceFinishReason[] = ["stop", "length", "tool_calls"];
export const EXECUTION_STATUSES: readonly ExecutionStatus[] = ["succeeded", "failed", "cancelled", "unknown"];
export const STREAM_EVENT_TYPES = [
  "request.started",
  "output.delta",
  "output.tool_call.delta",
  "output.tool_call.completed",
  "request.completed",
  "request.failed",
  "request.replayed",
] as const;

const IMAGE_DETAILS = ["auto", "low", "high"] as const;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const USAGE_METERS = ["input", "cached", "cache_write", "output"] as const;
const USAGE_EXTRAS = ["images", "video_ms", "audio_ms", "tasks"] as const;

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function toolName(add: Add, path: string, v: unknown): void {
  const message = "must be 1 to 64 letters, digits, _ or -";
  if (typeof v !== "string") wrongType(add, path, v, message);
  else if (!TOOL_NAME.test(v)) add(path, "format", message);
}

function positive(add: Add, path: string, v: unknown): void {
  const message = "must be a positive integer";
  if (typeof v !== "number") wrongType(add, path, v, message);
  else if (!Number.isInteger(v) || v < 1) add(path, "range", message);
}

function parts(add: Add, path: string, v: unknown[]): void {
  if (v.length === 0) return add(path, "empty", "must not be empty");
  v.forEach((part: unknown, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(part)) return wrongType(add, p, part, "must be an object");
    oneOf(add, `${p}.type`, part.type, ["text", "image"]);
    if (part.type === "text") str(add, `${p}.text`, part.text);
    if (part.type === "image") {
      const message = "must be an https URL or a data:image URL (png, jpeg, gif or webp, base64)";
      if (typeof part.url !== "string") wrongType(add, `${p}.url`, part.url, message);
      else if (!isHttpsUrl(part.url) && !DATA_IMAGE.test(part.url)) add(`${p}.url`, "format", message);
      if (part.detail !== undefined) oneOf(add, `${p}.detail`, part.detail, IMAGE_DETAILS);
    }
  });
}

function toolCalls(add: Add, path: string, v: unknown, made: Set<string>): void {
  if (!Array.isArray(v)) return wrongType(add, path, v, "must be an array");
  if (v.length === 0) return add(path, "empty", "must not be empty");
  const own = new Set<string>();
  v.forEach((call: unknown, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(call)) return wrongType(add, p, call, "must be an object");
    text(add, `${p}.id`, call.id);
    toolName(add, `${p}.name`, call.name);
    str(add, `${p}.arguments`, call.arguments);
    if (typeof call.id === "string" && call.id !== "") {
      if (own.has(call.id)) add(`${p}.id`, "unique", "duplicate tool call id");
      own.add(call.id);
    }
  });
  own.forEach((id) => made.add(id));
}

function message(add: Add, path: string, v: unknown, made: Set<string> | null): void {
  if (!isObject(v)) return wrongType(add, path, v, "must be an object");
  const at = (key: string) => (path === "" ? key : `${path}.${key}`);
  if (typeof v.role !== "string" || !(INFERENCE_ROLES as readonly string[]).includes(v.role)) return oneOf(add, at("role"), v.role, INFERENCE_ROLES);
  switch (v.role) {
    case "system":
      str(add, at("content"), v.content);
      break;
    case "user":
      if (Array.isArray(v.content)) parts(add, at("content"), v.content);
      else if (typeof v.content !== "string") wrongType(add, at("content"), v.content, "must be a string or an array of content parts");
      break;
    case "assistant":
      if (v.tool_calls !== undefined) {
        toolCalls(add, at("tool_calls"), v.tool_calls, made ?? new Set());
        if (v.content !== undefined) str(add, at("content"), v.content);
      } else str(add, at("content"), v.content);
      break;
    default:
      text(add, at("tool_call_id"), v.tool_call_id);
      str(add, at("content"), v.content);
      if (v.is_error !== undefined) bool(add, at("is_error"), v.is_error);
      if (made && typeof v.tool_call_id === "string" && v.tool_call_id !== "" && !made.has(v.tool_call_id)) add(at("tool_call_id"), "reference", "no earlier assistant message made this tool call");
  }
}

/**
 * Checks one message on its own: its role, its content and, for an assistant, its tool calls. Whether a tool
 * result answers a call an earlier message made needs the whole conversation; `validateInferenceRequest` checks it.
 */
export function validateInferenceMessage(value: unknown): Issue[] {
  const { issues, add } = collector();
  message(add, "", value, null);
  return issues;
}

/**
 * Checks a request before it is sent. A gateway that cannot call tools must refuse a request that declares them,
 * not ignore them: this says only whether the request is well formed, not whether a given gateway can serve it.
 */
export function validateInferenceRequest(value: unknown): Issue[] {
  const { issues, add } = collector();
  if (!isObject(value)) {
    wrongType(add, "", value, "request must be an object");
    return issues;
  }
  const r = value;
  text(add, "service", r.service);
  if (r.service_version !== undefined) count(add, "service_version", r.service_version);
  text(add, "customer_id", r.customer_id);
  if (!Array.isArray(r.messages)) wrongType(add, "messages", r.messages, "must be a non-empty array");
  else if (r.messages.length === 0) add("messages", "empty", "must be a non-empty array");
  else {
    const made = new Set<string>();
    r.messages.forEach((m: unknown, i) => message(add, `messages[${i}]`, m, made));
  }
  if (r.tools !== undefined) {
    if (!Array.isArray(r.tools)) wrongType(add, "tools", r.tools, "must be an array");
    else {
      const names = new Set<string>();
      r.tools.forEach((tool: unknown, i) => {
        const p = `tools[${i}]`;
        if (!isObject(tool)) return wrongType(add, p, tool, "must be an object");
        toolName(add, `${p}.name`, tool.name);
        if (tool.description !== undefined) str(add, `${p}.description`, tool.description);
        const schema = 'must be a JSON Schema object with type "object"';
        if (!isObject(tool.input_schema)) wrongType(add, `${p}.input_schema`, tool.input_schema, schema);
        else if (tool.input_schema.type !== "object") add(`${p}.input_schema`, "shape", schema);
        if (typeof tool.name === "string" && TOOL_NAME.test(tool.name)) {
          if (names.has(tool.name)) add(`${p}.name`, "unique", "duplicate tool name");
          names.add(tool.name);
        }
      });
    }
  }
  if (r.tool_choice !== undefined) {
    const c = r.tool_choice;
    if (isObject(c)) toolName(add, "tool_choice.name", c.name);
    else if (c !== "auto" && c !== "none" && c !== "required") add("tool_choice", typeof c === "string" ? "enum" : "type", 'must be "auto", "none", "required" or { name }', typeof c === "string" ? didYouMean(c, ["auto", "none", "required"]) : `got ${jsonType(c)}`);
  }
  if (r.max_output_tokens !== undefined) positive(add, "max_output_tokens", r.max_output_tokens);
  if (r.timeout_ms !== undefined) positive(add, "timeout_ms", r.timeout_ms);
  return issues;
}

function inferenceUsage(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "must be an object");
  text(add, `${path}.status`, v.status);
  if (v.meters === undefined) return;
  const m = v.meters;
  if (!isObject(m)) return wrongType(add, `${path}.meters`, m, "must be an object");
  for (const k of USAGE_METERS) count(add, `${path}.meters.${k}`, m[k]);
  for (const k of USAGE_EXTRAS) if (m[k] !== undefined) count(add, `${path}.meters.${k}`, m[k]);
}

/**
 * Checks one stream event of the gateway. For whoever produces events; a consumer skips a type it does not know
 * (`inferenceStreamOutcome` does), since later versions add types.
 */
export function validateStreamEvent(value: unknown): Issue[] {
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
  if (!(STREAM_EVENT_TYPES as readonly string[]).includes(e.type)) {
    add("type", "enum", "unknown stream event type", didYouMean(e.type, STREAM_EVENT_TYPES));
    return issues;
  }
  text(add, "request_id", e.request_id);
  count(add, "sequence", e.sequence);
  switch (e.type) {
    case "request.started":
      count(add, "service_version", e.service_version);
      break;
    case "output.delta":
      str(add, "text", e.text);
      break;
    case "output.tool_call.delta":
      count(add, "index", e.index);
      if (e.id !== undefined) text(add, "id", e.id);
      if (e.name !== undefined) toolName(add, "name", e.name);
      str(add, "arguments_delta", e.arguments_delta);
      break;
    case "output.tool_call.completed":
      count(add, "index", e.index);
      text(add, "id", e.id);
      toolName(add, "name", e.name);
      str(add, "arguments", e.arguments);
      break;
    case "request.completed":
      oneOf(add, "execution_status", e.execution_status, EXECUTION_STATUSES);
      text(add, "billing_status", e.billing_status);
      if (e.finish_reason !== undefined) oneOf(add, "finish_reason", e.finish_reason, INFERENCE_FINISH_REASONS);
      if (e.usage !== undefined) inferenceUsage(add, "usage", e.usage);
      break;
    case "request.failed":
      if (e.execution_status !== undefined) oneOf(add, "execution_status", e.execution_status, EXECUTION_STATUSES);
      if (e.billing_status !== undefined) text(add, "billing_status", e.billing_status);
      if (e.error !== undefined) {
        if (!isObject(e.error)) obj(add, "error", e.error);
        else text(add, "error.code", e.error.code);
      }
      if (e.usage !== undefined) inferenceUsage(add, "usage", e.usage);
      break;
    default:
  }
  return issues;
}

/**
 * - `completed`, `failed`, `replayed`: the first terminal event the stream delivered (`isTerminalEvent`).
 * - `interrupted`: it stopped before any terminal event; `collectText` throws `stream_interrupted` for it.
 * - `empty`: no stream event of a known type at all.
 */
export type InferenceStreamOutcome = "empty" | "completed" | "failed" | "replayed" | "interrupted";

/** What a stream that has stopped says about its request. Values that are not stream events of a known type are skipped. */
export function inferenceStreamOutcome(events: readonly unknown[]): InferenceStreamOutcome {
  let seen = false;
  for (const event of events) {
    if (!isObject(event) || typeof event.type !== "string" || !(STREAM_EVENT_TYPES as readonly string[]).includes(event.type)) continue;
    seen = true;
    if (event.type === "request.completed") return "completed";
    if (event.type === "request.failed") return "failed";
    if (event.type === "request.replayed") return "replayed";
  }
  return seen ? "interrupted" : "empty";
}
