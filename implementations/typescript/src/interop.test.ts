// The draft interop adapters against their golden files (conformance/interop-*.v0.json). The files are written by
// scripts/export-interop-*.mjs, which also checks every message in them against the real `ai` and `@ag-ui/core` packages;
// this test is the other half: the adapter in this package still produces exactly what the files say.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as agUi from "./interop/ag-ui.js";
import * as aiSdk from "./interop/ai-sdk.js";
import * as mcp from "./interop/mcp.js";
import * as otel from "./interop/otel.js";
import type { Loss } from "./interop/types.js";
import type { RunEvent } from "./run.js";

interface Scenario {
  confirmKinds?: string[];
  threadId?: string;
  runId?: string;
  now?: number;
}
const golden = (name: string) => JSON.parse(readFileSync(new URL(`../../../conformance/${name}`, import.meta.url), "utf8"));

/** A scenario's options in JSON, as the options of an adapter (the same translation the generators make). */
function optionsOf(scenario: Scenario = {}, losses: Loss[] = []) {
  const confirm = scenario.confirmKinds;
  return {
    onLoss: (loss: Loss) => losses.push(loss),
    ...(scenario.threadId !== undefined ? { threadId: scenario.threadId } : {}),
    ...(scenario.runId !== undefined ? { runId: scenario.runId } : {}),
    ...(confirm ? { isConfirm: (card: { spec: { kind: string } }) => confirm.includes(card.spec.kind), interruptReason: (card: { spec: { kind: string } }) => (confirm.includes(card.spec.kind) ? "confirmation" : "input_required") } : {}),
    ...(scenario.now !== undefined ? { now: () => scenario.now as number } : {}),
  };
}

describe.each([
  ["interop-ag-ui.v0.json", agUi, "events", "AG-UI"],
  ["interop-ai-sdk.v0.json", aiSdk, "chunks", "AI SDK"],
] as const)("%s", (file, adapter, inputKey, label) => {
  const data = golden(file);
  it("is marked draft", () => {
    expect(data.status).toBe("draft");
    expect(file).toMatch(/\.v0\.json$/);
  });
  describe(`${label} encode`, () => {
    for (const c of data.encode) {
      it(c.name, () => {
        const losses: Loss[] = [];
        const out = adapter.encode(c.events as RunEvent[], optionsOf(c.options, losses));
        expect(out).toEqual(c.expect);
        expect(losses).toEqual(c.loss);
        const back: Loss[] = [];
        const again = (adapter.decode as (e: unknown[], o: unknown) => RunEvent[])(out, optionsOf({ ...c.options, runId: c.options?.runId ?? "run_1", now: 1700000000000 }, back));
        expect(again).toEqual(c.roundtrip);
        expect(back).toEqual(c.roundtrip_loss);
      });
    }
  });
  describe(`${label} decode`, () => {
    for (const c of data.decode) {
      it(c.name, () => {
        const losses: Loss[] = [];
        const decoder = (adapter.createDecoder as (o: unknown) => { push(i: unknown): RunEvent[]; end(): RunEvent[]; resume?(e: unknown[]): RunEvent[] })(optionsOf(c.options, losses));
        const out: RunEvent[] = [];
        for (const input of c[inputKey]) out.push(...decoder.push(input));
        if (c.resume) out.push(...(decoder.resume?.(c.resume) ?? []));
        out.push(...decoder.end());
        expect(out).toEqual(c.expect);
        expect(losses).toEqual(c.loss);
      });
    }
  });
});

describe("a stream is a machine", () => {
  const events: RunEvent[] = [
    { type: "run-start", runId: "r", mode: "stream" },
    { type: "step-start", step: 0 },
    { type: "text-delta", delta: "a" },
    { type: "text-delta", delta: "b" },
    { type: "step-finish", step: 0, finishReason: "stop" },
    { type: "run-finish", runId: "r", finishReason: "stop", usage: {}, steps: 1 },
  ];
  it("gives the same output pushed one event at a time as in one go (AG-UI)", () => {
    const machine = agUi.createEncoder();
    const out = [...events.flatMap((e) => machine.push(e)), ...machine.end()];
    expect(out).toEqual(agUi.encode(events));
  });
  it("gives the same output pushed one event at a time as in one go (AI SDK)", () => {
    const machine = aiSdk.createEncoder();
    const out = [...events.flatMap((e) => machine.push(e)), ...machine.end()];
    expect(out).toEqual(aiSdk.encode(events));
  });
  it("does not need an onLoss to run", () => {
    expect(() => agUi.encode([{ type: "usage", usage: { inputTokens: 1 } }])).not.toThrow();
    expect(() => aiSdk.encode([{ type: "usage", usage: { inputTokens: 1 } }])).not.toThrow();
  });
  it("the AI SDK decoder says so when it has no run id", () => {
    expect(() => aiSdk.decode([{ type: "start" }])).toThrow(RangeError);
  });
  it("frames chunks as server-sent events ending with [DONE]", () => {
    expect(aiSdk.toSse([{ type: "start" }])).toBe('data: {"type":"start"}\n\ndata: [DONE]\n\n');
    expect(aiSdk.UI_MESSAGE_STREAM_HEADERS["x-vercel-ai-ui-message-stream"]).toBe("v1");
  });
});

// ---- the pure interop functions (MCP, OpenTelemetry) --------------------------------------------------------------------------

type PureCase = { fn: string; expect: { value?: unknown; error?: string } } & Record<string, any>;
const attempt = (fn: () => unknown) => {
  try {
    return { value: fn() ?? null };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const mcpFunctions: Record<string, (c: PureCase) => unknown> = {
  tool_annotations: (c) => mcp.toolAnnotationsFromAuthority(c.value),
  authority_from_annotations: (c) => mcp.authorityFromAnnotations(c.annotations, "trusted" in c ? { trusted: c.trusted } : undefined),
  authority_round_trip: (c) => mcp.authorityFromAnnotations(mcp.toolAnnotationsFromAuthority(c.authority), { trusted: true }),
  theme_to_mcp_apps: (c) => mcp.hostThemeToMcpAppsContext(c.theme),
  theme_from_mcp_apps: (c) => mcp.hostThemeFromMcpAppsContext(c.context),
  theme_round_trip: (c) => mcp.hostThemeFromMcpAppsContext(mcp.hostThemeToMcpAppsContext(c.theme)),
  placement_to_display_mode: (c) => mcp.placementToDisplayMode(c.placement, c.panelAs),
  display_mode_to_placement: (c) => mcp.displayModeToPlacement(c.mode),
  elicitation_action: (c) => mcp.cardResponseToElicitationAction(c.value),
  style_variables: () => ({ count: mcp.MCP_APPS_STYLE_VARIABLES.length, unique: new Set(mcp.MCP_APPS_STYLE_VARIABLES).size, variables: [...mcp.MCP_APPS_STYLE_VARIABLES] }),
};
const otelFunctions: Record<string, (c: PureCase) => unknown> = {
  usage_attributes: (c) => otel.usageAttributes(c.usage, c.reading),
  meters_attributes: (c) => otel.usageAttributesFromMeters(c.meters, c.input),
  finish_reason: (c) => otel.finishReasonAttributes(c.value),
  tool_attributes: (c) => otel.toolAttributes(c.call, c.result),
  tool_span_name: (c) => otel.toolSpanName(c.name),
  run_attributes: (c) => otel.runAttributes(c.start, c.failed),
  attribute_names: () => ({ ...otel.GEN_AI }),
};

describe.each([
  ["interop-mcp.v0.json", "interop_mcp", mcpFunctions],
  ["interop-otel.v0.json", "interop_otel", otelFunctions],
] as const)("%s", (file, section, functions) => {
  const data = golden(file);
  it("is marked draft and every case names a function this module has", () => {
    expect(data.status).toBe("draft");
    expect(file).toMatch(/\.v0\.json$/);
    for (const c of data[section] as PureCase[]) expect(Object.keys(functions), JSON.stringify(c)).toContain(c.fn);
  });
  it("covers every function", () => {
    expect(new Set((data[section] as PureCase[]).map((c) => c.fn))).toEqual(new Set(Object.keys(functions)));
  });
  for (const [i, c] of (data[section] as PureCase[]).entries()) {
    it(`${c.fn}[${i}]`, () => {
      expect(attempt(() => functions[c.fn]!(structuredClone(c))), JSON.stringify(c)).toEqual(c.expect);
    });
  }
});

describe("MCP interop", () => {
  it("lists the 76 standardized MCP Apps variables once each, and every mapped one is on the list", () => {
    expect(mcp.MCP_APPS_STYLE_VARIABLES).toHaveLength(76);
    expect(new Set(mcp.MCP_APPS_STYLE_VARIABLES).size).toBe(76);
    for (const variable of Object.values(mcp.MCP_APPS_VARIABLE_OF_TOKEN)) expect(mcp.isMcpAppsStyleVariable(variable)).toBe(true);
    expect(mcp.isMcpAppsStyleVariable("--super-text")).toBe(false);
  });
  it("maps each variable from one token only", () => {
    const variables = Object.values(mcp.MCP_APPS_VARIABLE_OF_TOKEN);
    expect(new Set(variables).size).toBe(variables.length);
  });
  it("never trusts annotations unless told to", () => {
    expect(mcp.authorityFromAnnotations({ readOnlyHint: true })).toBeNull();
    expect(mcp.authorityFromAnnotations({ readOnlyHint: true }, { trusted: false })).toBeNull();
    expect(mcp.authorityFromAnnotations({ readOnlyHint: true }, { trusted: true })).toBe("read");
  });
});

describe("OpenTelemetry interop", () => {
  it("counts cached tokens into input the way the conventions ask, whatever the usage counted", () => {
    const usage = { inputTokens: 100, cachedInputTokens: 30 };
    const input = (reading: "includes-cached" | "excludes-cached") => otel.usageAttributes(usage, { input: reading, output: "includes-reasoning" })[otel.GEN_AI.inputTokens];
    expect(input("includes-cached")).toBe(100);
    expect(input("excludes-cached")).toBe(130);
  });
  it("does not write an unknown count as 0", () => {
    expect(otel.usageAttributes({}, { input: "includes-cached", output: "includes-reasoning" })).toEqual({});
  });
});
