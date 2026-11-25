import { describe, expect, it } from "vitest";
import { RUN_FINISH_REASONS, finishReasonFromGateway, finishReasonToGateway, metersFromRunUsage, runUsageFromMeters, validateRunEvent } from "./index.js";

describe("finish reasons", () => {
  it("round-trips the three words both sides have and refuses to invent the rest", () => {
    for (const gateway of ["stop", "length", "tool_calls"] as const) expect(finishReasonToGateway(finishReasonFromGateway(gateway))).toBe(gateway);
    for (const reason of RUN_FINISH_REASONS) {
      const back = finishReasonToGateway(reason);
      expect(back === null, reason).toBe(["content-filter", "cancelled", "error", "unknown"].includes(reason));
    }
    expect(finishReasonFromGateway(undefined)).toBe("unknown");
    expect(finishReasonFromGateway("content_filter")).toBe("unknown");
  });
});

describe("usage", () => {
  const meters = { input: 100, cached: 30, cache_write: 10, output: 20 };
  it("converts between the two readings of input and says what it loses", () => {
    // input counted with the cache in it on both sides: nothing changes but cache_write, which RunUsage cannot hold.
    expect(runUsageFromMeters(meters, { meters: "includes-cached", run: "includes-cached" })).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 });
    // Claude-native counting (input excludes the cache) read as OpenTelemetry counts it (input includes it).
    expect(runUsageFromMeters(meters, { meters: "excludes-cached", run: "includes-cached" }).inputTokens).toBe(140);
    expect(metersFromRunUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 }, { meters: "includes-cached", run: "includes-cached" })).toEqual({ input: 100, cached: 30, cache_write: 0, output: 20 });
  });
  it("throws instead of guessing when the reading cannot be right", () => {
    expect(() => runUsageFromMeters({ input: 1, cached: 900, cache_write: 0, output: 1 }, { meters: "includes-cached", run: "includes-cached" })).toThrow(RangeError);
    expect(() => metersFromRunUsage({ outputTokens: 1 }, { meters: "includes-cached", run: "includes-cached" })).toThrow("usage.inputTokens must be a non-negative number");
  });
});

describe("optional run event fields", () => {
  it("accepts threadId, seq and a delta id, and says where a bad one is", () => {
    expect(validateRunEvent({ type: "run-start", runId: "r", mode: "stream", threadId: "t1", seq: 0 })).toEqual([]);
    expect(validateRunEvent({ type: "text-delta", delta: "x", id: "m1", seq: 3 })).toEqual([]);
    expect(validateRunEvent({ type: "text-delta", delta: "x", id: "", seq: -1 })).toEqual([
      { path: "id", code: "empty", message: "must be a non-empty string" },
      { path: "seq", code: "range", message: "must be a non-negative integer" },
    ]);
  });
});
