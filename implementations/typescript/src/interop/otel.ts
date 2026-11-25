/**
 * OpenTelemetry GenAI attributes for run events (DRAFT: the interop modules are not stable; see docs/INTEROP.md).
 *
 * Pure functions that return the attribute dictionary of a span; the application creates the span with whatever
 * OpenTelemetry SDK it has, so this package takes no `@opentelemetry/*` dependency. The attribute names are in one
 * place (`GEN_AI`) because the GenAI conventions are in Development and still change: a rename is one edit here and one in
 * `conformance/interop-otel.v0.json`.
 *
 * Written against the OpenTelemetry GenAI semantic conventions repository (`semantic-conventions-genai`), where the
 * `gen_ai.*` attributes now live. The older registry in `semantic-conventions` marks the same attributes deprecated and
 * calls the cache-write count `gen_ai.usage.cache_creation.input_tokens`; the current name is `cache_write`.
 *
 * Counting is the one place the words do not settle the meaning, so it is an argument and never guessed:
 * - `gen_ai.usage.input_tokens` SHOULD include cached tokens, cache reads and cache writes among them. The run's
 *   `inputTokens` may or may not (docs/RUN-EVENTS.md: not decided), so the caller says how the usage it passes counts.
 * - `gen_ai.usage.output_tokens` SHOULD include reasoning tokens. Whether the run's `outputTokens` does is not written
 *   down either, so that is an argument too.
 */
import type { InputCounting } from "../mapping.js";
import { isCount } from "../check.js";
import type { Usage } from "../router.js";
import type { RunEvent, RunFinishReason, RunUsage } from "../run.js";

/** The attribute names. */
export const GEN_AI = {
  operationName: "gen_ai.operation.name",
  conversationId: "gen_ai.conversation.id",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  finishReasons: "gen_ai.response.finish_reasons",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  cacheWriteInputTokens: "gen_ai.usage.cache_write.input_tokens",
  reasoningOutputTokens: "gen_ai.usage.reasoning.output_tokens",
  errorType: "error.type",
} as const;

/** Values of `gen_ai.operation.name`. */
export const GEN_AI_OPERATION = { invokeAgent: "invoke_agent", executeTool: "execute_tool" } as const;

/** The value of `error.type` when there is no code: OpenTelemetry's fallback, and a low-cardinality one. */
export const ERROR_TYPE_OTHER = "_OTHER";

export type GenAiAttributes = Record<string, string | number | string[]>;

/** How the `outputTokens` of a run's usage counts: with the reasoning tokens in it, or without them. */
export type OutputCounting = "includes-reasoning" | "excludes-reasoning";

/** How the usage handed to `usageAttributes` counts. */
export interface UsageReading {
  input: InputCounting;
  output: OutputCounting;
}

/** `v` when it is a count; else a `RangeError` naming it. A usage with a negative or fractional count is bad data. */
function count(name: string, v: unknown): number {
  if (!isCount(v)) throw new RangeError(`${name} must be a non-negative integer`);
  return v as number;
}

/**
 * The usage attributes of one model call or one run. A count that is absent is left out, never written as 0: an unknown
 * count is not zero.
 *
 * - `gen_ai.usage.input_tokens` is `inputTokens` when the reading includes cached tokens, `inputTokens` plus
 *   `cachedInputTokens` when it does not.
 * - `gen_ai.usage.output_tokens` is `outputTokens` when the reading includes reasoning, plus `reasoningTokens` when not.
 * - `cache_read.input_tokens` and `reasoning.output_tokens` are `cachedInputTokens` and `reasoningTokens`.
 *
 * `RunUsage` has no count of cache writes. If the reading excludes cached tokens and some were written to the cache, the
 * input is understated by that many: use `usageAttributesFromMeters` where the meters have them.
 *
 * Throws a `RangeError` for a count that is not a non-negative integer, and for a reading that cannot be true of the
 * numbers (an "includes" count smaller than the part it should contain): guessing the other reading would misreport.
 */
export function usageAttributes(usage: RunUsage, reading: UsageReading): GenAiAttributes {
  const out: GenAiAttributes = {};
  const cached = usage.cachedInputTokens === undefined ? undefined : count("usage.cachedInputTokens", usage.cachedInputTokens);
  const reasoning = usage.reasoningTokens === undefined ? undefined : count("usage.reasoningTokens", usage.reasoningTokens);
  if (usage.inputTokens !== undefined) {
    const input = count("usage.inputTokens", usage.inputTokens);
    if (reading.input === "includes-cached" && input < (cached ?? 0)) throw new RangeError("usage.inputTokens is smaller than cachedInputTokens, so it does not include it: use excludes-cached");
    out[GEN_AI.inputTokens] = reading.input === "includes-cached" ? input : input + (cached ?? 0);
  }
  if (usage.outputTokens !== undefined) {
    const output = count("usage.outputTokens", usage.outputTokens);
    if (reading.output === "includes-reasoning" && output < (reasoning ?? 0)) throw new RangeError("usage.outputTokens is smaller than reasoningTokens, so it does not include it: use excludes-reasoning");
    out[GEN_AI.outputTokens] = reading.output === "includes-reasoning" ? output : output + (reasoning ?? 0);
  }
  if (cached !== undefined) out[GEN_AI.cacheReadInputTokens] = cached;
  if (reasoning !== undefined) out[GEN_AI.reasoningOutputTokens] = reasoning;
  return out;
}

/**
 * The usage attributes of a gateway's meters (`Usage`), which count cache writes too. `input` says how `meters.input`
 * counts. The cache counts are always written (a meter is a number); a reading that cannot be true of the numbers throws
 * a `RangeError`, as in `usageAttributes`. Meters have no reasoning count, so `output_tokens` is `meters.output`.
 */
export function usageAttributesFromMeters(meters: Pick<Usage, "input" | "cached" | "cache_write" | "output">, input: InputCounting): GenAiAttributes {
  const base = count("meters.input", meters.input);
  const cached = count("meters.cached", meters.cached);
  const written = count("meters.cache_write", meters.cache_write);
  const output = count("meters.output", meters.output);
  if (input === "includes-cached" && base < cached + written) throw new RangeError("meters.input is smaller than cached + cache_write, so it does not include them: use excludes-cached");
  return {
    [GEN_AI.inputTokens]: input === "includes-cached" ? base : base + cached + written,
    [GEN_AI.outputTokens]: output,
    [GEN_AI.cacheReadInputTokens]: cached,
    [GEN_AI.cacheWriteInputTokens]: written,
  };
}

// The conventions say a finish reason is the provider's own word. These are the OpenAI-style words, the ones the gateway
// (`tool_calls`) already uses; the run's `cancelled` is the convention's `interrupted` (the caller stopped the generation
// without an error).
const FINISH_REASON: Readonly<Partial<Record<RunFinishReason, string>>> = {
  stop: "stop",
  length: "length",
  "tool-calls": "tool_calls",
  "content-filter": "content_filter",
  error: "error",
  cancelled: "interrupted",
};

/**
 * `{ "gen_ai.response.finish_reasons": [reason] }` for the finish reason of one generation, or `{}` for `unknown` and for
 * a value that is not a finish reason: a reason the run did not know is not made up on the other side.
 */
export function finishReasonAttributes(reason: unknown): GenAiAttributes {
  const word = FINISH_REASON[reason as RunFinishReason];
  return word === undefined ? {} : { [GEN_AI.finishReasons]: [word] };
}

/** The name of the span of a tool call: `execute_tool {gen_ai.tool.name}`. */
export const toolSpanName = (name: string): string => `${GEN_AI_OPERATION.executeTool} ${name}`;

/**
 * The attributes of the `execute_tool` span of a call. The span starts at the `tool-call` event and ends at the
 * `tool-result` with the same `callId`: pass the call, and the result once it is there. A result with `failure` sets
 * `error.type` to `_OTHER`: the failure is a message, which is high-cardinality, and `error.type` must not be.
 */
export function toolAttributes(call: Extract<RunEvent, { type: "tool-call" }>, result?: Extract<RunEvent, { type: "tool-result" }>): GenAiAttributes {
  const out: GenAiAttributes = { [GEN_AI.operationName]: GEN_AI_OPERATION.executeTool, [GEN_AI.toolName]: call.name, [GEN_AI.toolCallId]: call.callId };
  if (result?.failure !== undefined) out[GEN_AI.errorType] = ERROR_TYPE_OTHER;
  return out;
}

/**
 * The attributes of the `invoke_agent` span of a run, from its `run-start`: the operation (an LLM drives the control flow
 * through tool calls) and, when the run has one, the thread as `gen_ai.conversation.id`. The run's usage and finish
 * reason come from its `run-finish` (`usageAttributes`, `finishReasonAttributes`); a failed run sets `error.type`: pass
 * its `error` event's code as `errorType`, or leave it out for `_OTHER`.
 */
export function runAttributes(start: Extract<RunEvent, { type: "run-start" }>, failed?: { errorType?: string }): GenAiAttributes {
  const out: GenAiAttributes = { [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent };
  if (start.threadId !== undefined) out[GEN_AI.conversationId] = start.threadId;
  if (failed) out[GEN_AI.errorType] = failed.errorType !== undefined && failed.errorType !== "" ? failed.errorType : ERROR_TYPE_OTHER;
  return out;
}
