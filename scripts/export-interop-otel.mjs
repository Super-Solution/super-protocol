// Writes conformance/interop-otel.v0.json (DRAFT, like the agent-loop files: not part of protocol.v1.json and not stable):
// what the functions of implementations/typescript/src/interop/otel.ts return, in the shape of the `mapping` section of
// protocol.v1.json: `{ fn, ...inputs, expect: { value } | { error } }`.
//
// The expected values are what the TypeScript reference returns. They are NOT checked against an OpenTelemetry package
// (none is a dependency of this package); the attribute names and the counting rules come from the GenAI semantic
// conventions (`semantic-conventions-genai`), whose attributes are in Development: when one changes, `GEN_AI` in otel.ts and
// this file change together.
//
// Run `pnpm build` first (the generator imports the built package). `--check` is what scripts/check-all.sh runs.
import { fileURLToPath } from "node:url";
import { writeGolden } from "./lib/golden.mjs";
import * as otel from "../implementations/typescript/dist/interop/otel.js";

const run = (fn) => {
  try {
    return { value: fn() ?? null };
  } catch (e) {
    return { error: e.message };
  }
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const cases = [];
const add = (fn, inputs, call) => cases.push({ fn, ...inputs, expect: run(() => call(clone(inputs))) });

// The numbers of the table in docs/RUN-EVENTS.md: input 100, cached 30, cache_write 10.
const readings = [];
for (const input of ["includes-cached", "excludes-cached"]) for (const output of ["includes-reasoning", "excludes-reasoning"]) readings.push({ input, output });

const usages = [
  { inputTokens: 100, outputTokens: 40, cachedInputTokens: 30, reasoningTokens: 15 },
  { inputTokens: 1, outputTokens: 12, cachedInputTokens: 900 },
  { inputTokens: 100, outputTokens: 40 },
  { inputTokens: 100 },
  { outputTokens: 7, reasoningTokens: 7 },
  { cachedInputTokens: 0, reasoningTokens: 0 },
  { totalTokens: 140 },
  {},
  { inputTokens: 30, outputTokens: 5, cachedInputTokens: 30 },
  { inputTokens: -1, outputTokens: 5 },
  { inputTokens: 1.5 },
  { inputTokens: "100" },
  { outputTokens: 3, reasoningTokens: 9 },
  { inputTokens: 10, cachedInputTokens: -2 },
];
for (const usage of usages) for (const reading of readings) add("usage_attributes", { usage, reading }, ({ usage: u, reading: r }) => otel.usageAttributes(u, r));

const meters = [
  { input: 100, cached: 30, cache_write: 10, output: 40 },
  { input: 60, cached: 30, cache_write: 10, output: 40 },
  { input: 39, cached: 30, cache_write: 10, output: 5 },
  { input: 1, cached: 900, cache_write: 0, output: 12 },
  { input: 0, cached: 0, cache_write: 0, output: 0 },
  { input: 5, cached: 0, cache_write: 0, output: 1.5 },
  { input: 5, cached: 0, cache_write: -1, output: 1 },
  { input: 5, cached: 0, output: 1 },
];
for (const m of meters) for (const input of ["includes-cached", "excludes-cached"]) add("meters_attributes", { meters: m, input }, ({ meters: x, input: i }) => otel.usageAttributesFromMeters(x, i));

for (const value of ["stop", "length", "tool-calls", "content-filter", "error", "cancelled", "unknown", "tool_calls", "STOP", "", null, undefined, 5]) add("finish_reason", { value }, ({ value: v }) => otel.finishReasonAttributes(v));

const call = { type: "tool-call", callId: "call_1", name: "search", input: { q: "cats" } };
const ok = { type: "tool-result", callId: "call_1", name: "search", output: "3 results", ms: 120 };
const failed = { type: "tool-result", callId: "call_1", name: "search", output: null, failure: "timeout after 30s for host 10.0.0.7", ms: 30000 };
add("tool_attributes", { call }, ({ call: c }) => otel.toolAttributes(c));
add("tool_attributes", { call, result: ok }, ({ call: c, result }) => otel.toolAttributes(c, result));
add("tool_attributes", { call, result: failed }, ({ call: c, result }) => otel.toolAttributes(c, result));
add("tool_attributes", { call: { ...call, repaired: true, loading: { text: "Searching" } }, result: { ...failed, failure: "" } }, ({ call: c, result }) => otel.toolAttributes(c, result));
add("tool_span_name", { name: "search" }, ({ name }) => otel.toolSpanName(name));

const start = { type: "run-start", runId: "run_1", mode: "stream" };
add("run_attributes", { start }, ({ start: s }) => otel.runAttributes(s));
add("run_attributes", { start: { ...start, threadId: "thread_9", protocol: "0.5" } }, ({ start: s }) => otel.runAttributes(s));
add("run_attributes", { start: { ...start, threadId: "thread_9" }, failed: {} }, ({ start: s, failed: f }) => otel.runAttributes(s, f));
add("run_attributes", { start, failed: { errorType: "provider_error" } }, ({ start: s, failed: f }) => otel.runAttributes(s, f));
add("run_attributes", { start, failed: { errorType: "" } }, ({ start: s, failed: f }) => otel.runAttributes(s, f));

add("attribute_names", {}, () => ({ ...otel.GEN_AI }));

writeGolden(
  fileURLToPath(new URL("../conformance/interop-otel.v0.json", import.meta.url)),
  {
    version: 0,
    status: "draft",
    note: "DRAFT, not stable and not part of protocol.v1.json. Generated by scripts/export-interop-otel.mjs from implementations/typescript/src/interop/otel.ts. Case shape as in the `mapping` section of protocol.v1.json: `fn` names the function, the other keys are its inputs, `expect` is `{ value }` or `{ error }` (a RangeError message). Not checked against an OpenTelemetry package; the attributes are in Development in the GenAI conventions. `undefined` inputs are written as an absent key.",
    generated_with: { otel_genai_semantic_conventions: "semantic-conventions-genai main, fetched 2026-11-25" },
    interop_otel: cases,
  },
  "export-interop-otel.mjs",
);
