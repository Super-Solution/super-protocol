/**
 * Conversions between the gateway's words and a run's words for the same things. The gateway (`router.ts`) and the
 * run events (`run.ts`) grew separately, so a finish reason, a token count and a tool call id are spelled two ways.
 * These are pure functions; nothing here renames a field of either side.
 *
 * Counting input is the one place the words do not settle the meaning. Some systems count `input` as everything the
 * model read, cached tokens included; others count only the tokens that were neither read from nor written to the
 * cache (OpenTelemetry's `gen_ai.usage.input_tokens` is the first kind; a Claude-native API reports the second).
 * Which one `Usage.input` and `RunUsage.inputTokens` mean is an open decision (docs/RUN-EVENTS.md), so the two usage
 * functions take the reading of each side as an argument and never guess.
 */
import type { InferenceFinishReason, Usage } from "./router.js";
import type { RunFinishReason, RunUsage } from "./run.js";

/**
 * The run word for a gateway `finish_reason`. A value the gateway did not send, or one this version does not know, is
 * `unknown`: the run never claims a reason the gateway did not give.
 */
export function finishReasonFromGateway(reason: unknown): RunFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    default:
      return "unknown";
  }
}

/**
 * The gateway word for a run's finish reason, or `null` when the gateway has none: it cannot say `content-filter`,
 * `cancelled`, `error` or `unknown`, and a value that is not a finish reason at all gets `null` too.
 */
export function finishReasonToGateway(reason: unknown): InferenceFinishReason | null {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
      return "tool_calls";
    default:
      return null;
  }
}

/** How a system counts `input`: with the cached tokens in it, or without them. */
export type InputCounting = "includes-cached" | "excludes-cached";

/** The reading of the gateway's `Usage.input` (`meters`) and of the run's `RunUsage.inputTokens` (`run`). */
export interface UsageCounting {
  meters: InputCounting;
  run: InputCounting;
}

/** `v` when it is a non-negative number, else a `RangeError` naming it. */
function amount(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a non-negative number`);
  return v;
}

/**
 * A run's usage from a gateway's meters. `cache_write` has no field in `RunUsage`: when the run counts input with the
 * cache in it, the written tokens are inside `inputTokens`; otherwise they are dropped. `images`, `video_ms`, `audio_ms`
 * and `tasks` have no run counterpart and are dropped.
 *
 * Throws a `RangeError` when `counting.meters` is `includes-cached` and `input` is smaller than `cached + cache_write`:
 * the input then cannot contain them, so it is the other reading, and guessing would misreport the tokens.
 */
export function runUsageFromMeters(meters: Usage, counting: UsageCounting): RunUsage {
  const input = amount("meters.input", meters.input);
  const cached = amount("meters.cached", meters.cached);
  const written = amount("meters.cache_write", meters.cache_write);
  const output = amount("meters.output", meters.output);
  const base = counting.meters === "includes-cached" ? input - cached - written : input;
  if (base < 0) throw new RangeError("meters.input is smaller than cached + cache_write, so it does not include them: use excludes-cached");
  return {
    inputTokens: counting.run === "includes-cached" ? base + cached + written : base,
    outputTokens: output,
    cachedInputTokens: cached,
  };
}

/**
 * A gateway's meters from a run's usage. `RunUsage` does not carry `cache_write`, so it comes back as 0 and, when the
 * run counts input with the cache in it, the written tokens stay inside `input`; `reasoningTokens` and `totalTokens`
 * have no meter and are dropped.
 *
 * Throws a `RangeError` when `inputTokens` or `outputTokens` is absent (a meter is a number, and an unknown count is not
 * 0), when a count is not a non-negative number, or when `counting.run` is `includes-cached` and `inputTokens` is smaller
 * than `cachedInputTokens`.
 */
export function metersFromRunUsage(usage: RunUsage, counting: UsageCounting): Usage {
  const inputTokens = amount("usage.inputTokens", usage.inputTokens);
  const outputTokens = amount("usage.outputTokens", usage.outputTokens);
  const cached = amount("usage.cachedInputTokens", usage.cachedInputTokens === undefined ? 0 : usage.cachedInputTokens);
  const base = counting.run === "includes-cached" ? inputTokens - cached : inputTokens;
  if (base < 0) throw new RangeError("usage.inputTokens is smaller than cachedInputTokens, so it does not include it: use excludes-cached");
  return { input: counting.meters === "includes-cached" ? base + cached : base, cached, cache_write: 0, output: outputTokens };
}
