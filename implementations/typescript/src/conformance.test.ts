// The TypeScript reference must still produce every expectation in conformance/protocol.v1.json,
// the data the Go and Python ports are tested against. Regenerate with
// `pnpm build && pnpm conformance:export`
// when behaviour changes on purpose, then update every port.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ISSUE_CODES,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  compareProtocolVersions,
  parseProtocolFeature,
  parseProtocolVersion,
  PLUGIN_TOOL_PRESETS,
  didYouMean,
  finishReasonFromGateway,
  finishReasonToGateway,
  metersFromRunUsage,
  runUsageFromMeters,
  canPlaceCard,
  inferenceStreamOutcome,
  panelCardKinds,
  pluginToolAuthority,
  readHostTheme,
  themeVariables,
  validateChatPlugin,
  validateInferenceMessage,
  validateInferenceRequest,
  validateStreamEvent,
  formatCardRef,
  isCardPlacement,
  isRunEventType,
  isRunTerminalEvent,
  isTerminalEvent,
  parseCardRef,
  parseChartRef,
  parseSSE,
  runStreamOutcome,
  validateChartCardSpec,
  validateEditorCardSpec,
  validatePlotCardSpec,
  validatePluginManifest,
  validateRunEvent,
  PLOT_FALLBACK_MESSAGE,
} from "./index.js";

const data = JSON.parse(readFileSync(new URL("../../../conformance/protocol.v1.json", import.meta.url), "utf8"));

/** Every issue (path, code, message, hint) in an expectation: a list of issues, or a card result that carries them. */
function issuesIn(expect: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(expect)) return expect;
  const issues = (expect as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) ? issues : [];
}

describe("conformance data", () => {
  it("issue codes", () => {
    expect(data.issue_codes.codes).toEqual([...ISSUE_CODES]);
    const seen = new Set<unknown>();
    for (const key of ["plugin_manifest", "editor_card", "chart_card", "plot_card", "run_event", "chat_plugin", "inference_message", "inference_request", "stream_event"]) {
      for (const c of data[key]) {
        for (const i of issuesIn(key === "chat_plugin" ? c.expect.issues : c.expect)) {
          expect(Object.keys(i).filter((k) => !["path", "code", "message", "hint"].includes(k))).toEqual([]);
          expect(ISSUE_CODES, `${key}: ${JSON.stringify(i)}`).toContain(i.code);
          if ("hint" in i) expect(typeof i.hint).toBe("string");
          seen.add(i.code);
        }
        // A card result's `error` is the first issue's message.
        if (c.expect?.ok === false) expect(c.expect.error).toBe(c.expect.issues[0].message);
      }
    }
    // Every code in the vocabulary is exercised by the data, so a port cannot leave one out unnoticed.
    expect([...ISSUE_CODES].filter((code) => !seen.has(code))).toEqual([]);
  });
  it("protocol version", () => {
    expect(data.protocol).toEqual({ version: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] });
    expect(data.protocol_version.length).toBeGreaterThanOrEqual(60);
    for (const c of data.protocol_version) {
      if (c.fn === "parse") expect(parseProtocolVersion(c.value)).toEqual(c.expect);
      else if (c.fn === "compare") expect(compareProtocolVersions(c.a, c.b)).toEqual(c.expect);
      else {
        const f = parseProtocolFeature(c.value);
        expect(f === null ? null : { name: f.name, major: f.version.major, minor: f.version.minor }).toEqual(c.expect);
      }
    }
  });
  it("mapping", () => {
    expect(data.mapping.length).toBeGreaterThanOrEqual(120);
    const run = (fn: () => unknown) => {
      try {
        return { value: fn() ?? null };
      } catch (e) {
        return { error: (e as Error).message };
      }
    };
    for (const c of data.mapping) {
      const got =
        c.fn === "finish_from_gateway"
          ? run(() => finishReasonFromGateway(c.value))
          : c.fn === "finish_to_gateway"
            ? run(() => finishReasonToGateway(c.value))
            : c.fn === "usage_from_meters"
              ? run(() => runUsageFromMeters(c.meters, c.counting))
              : run(() => metersFromRunUsage(c.usage, c.counting));
      expect(got, JSON.stringify(c)).toEqual(c.expect);
    }
  });
  it("did you mean", () => {
    expect(data.did_you_mean.length).toBeGreaterThanOrEqual(25);
    for (const c of data.did_you_mean) expect(didYouMean(c.value, c.allowed) ?? null).toEqual(c.expect);
  });
  it("plugin manifest", () => {
    expect(data.plugin_manifest.length).toBeGreaterThanOrEqual(100);
    for (const c of data.plugin_manifest) expect(validatePluginManifest(c.value)).toEqual(c.expect);
  });
  it("editor card", () => {
    for (const c of data.editor_card) expect(validateEditorCardSpec(c.value)).toEqual(c.expect);
  });
  it("chart card", () => {
    expect(data.chart_card.length).toBeGreaterThanOrEqual(200);
    for (const c of data.chart_card) expect(validateChartCardSpec(c.value)).toEqual(c.expect);
  });
  it("plot card", () => {
    expect(data.plot_card.length).toBeGreaterThanOrEqual(60);
    for (const c of data.plot_card) expect(validatePlotCardSpec(c.value)).toEqual(c.expect);
  });
  it("plot fallback message", () => {
    expect(PLOT_FALLBACK_MESSAGE).toBe(data.plot_fallback_message);
  });
  it("card refs", () => {
    expect(data.card_ref_parse.length).toBeGreaterThanOrEqual(80);
    for (const c of data.card_ref_parse) expect(parseCardRef(c.value !== null && typeof c.value === "object" && !Array.isArray(c.value) && c.value.undefined === true ? undefined : c.value)).toEqual(c.expect);
    for (const c of data.card_ref_format) expect(formatCardRef(c.value)).toEqual(c.expect);
    for (const c of data.chart_ref) expect(c.value === null ? null : parseChartRef(c.value)).toEqual(c.expect);
  });
  it("terminal events", () => {
    for (const c of data.terminal_event) expect(isTerminalEvent({ type: c.type } as never)).toBe(c.expect);
  });
  it("run events", () => {
    expect(data.run_event.length).toBeGreaterThanOrEqual(1000);
    for (const c of data.run_event) expect(validateRunEvent(c.value)).toEqual(c.expect);
    expect(data.run_event_type.length).toBeGreaterThanOrEqual(25);
    for (const c of data.run_event_type) expect({ known: isRunEventType(c.type), terminal: isRunTerminalEvent({ type: c.type }) }).toEqual(c.expect);
    expect(data.run_stream_outcome.length).toBeGreaterThanOrEqual(30);
    for (const c of data.run_stream_outcome) expect(runStreamOutcome(c.events)).toBe(c.expect);
  });
  it("card placement", () => {
    expect(data.card_placement.length).toBeGreaterThanOrEqual(30);
    for (const c of data.card_placement)
      expect({ valid: isCardPlacement(c.value), allowed: canPlaceCard(c.interactive === null ? undefined : { interactive: c.interactive }, c.value) }).toEqual(c.expect);
  });
  it("host theme", () => {
    expect(data.host_theme.length).toBeGreaterThanOrEqual(100);
    for (const c of data.host_theme) {
      const theme = readHostTheme(c.value);
      expect({ theme, variables: theme === null ? null : themeVariables(theme) }).toEqual(c.expect);
    }
  });
  it("tool authority", () => {
    for (const c of data.tool_authority) {
      const authority = pluginToolAuthority(c.tool);
      expect({ authority, presets: authority === null ? [] : PLUGIN_TOOL_PRESETS[authority] }).toEqual(c.expect);
    }
  });
  it("chat plugin", () => {
    expect(data.chat_plugin.length).toBeGreaterThanOrEqual(40);
    for (const c of data.chat_plugin) {
      const p = c.plugin;
      const plugin = {
        manifest: p.manifest,
        cardKinds: p.cardKinds?.map(({ kind }: { kind: string }) => ({ kind, summary: "", schema: {}, validate: () => ({ ok: true as const }) })),
        mounts: p.mounts && Object.fromEntries((p.mounts as string[]).map((kind) => [kind, () => ({ update() {}, destroy() {} })])),
        tools: p.tools?.map((t: object) => ({ ...t, description: "", inputSchema: {}, run: async () => null })),
      };
      const issues = validateChatPlugin(plugin as never);
      expect({ issues, panel_kinds: validatePluginManifest(plugin.manifest).length === 0 ? panelCardKinds(plugin as never) : null }).toEqual(c.expect);
    }
  });
  it("inference messages, requests and stream events", () => {
    expect(data.inference_message.length).toBeGreaterThanOrEqual(80);
    for (const c of data.inference_message) expect(validateInferenceMessage(c.value)).toEqual(c.expect);
    expect(data.inference_request.length).toBeGreaterThanOrEqual(200);
    for (const c of data.inference_request) expect(validateInferenceRequest(c.value)).toEqual(c.expect);
    expect(data.stream_event.length).toBeGreaterThanOrEqual(400);
    for (const c of data.stream_event) expect(validateStreamEvent(c.value)).toEqual(c.expect);
    expect(data.inference_stream_outcome.length).toBeGreaterThanOrEqual(15);
    for (const c of data.inference_stream_outcome) expect(inferenceStreamOutcome(c.events)).toBe(c.expect);
  });
  it("sse", async () => {
    expect(data.sse.length).toBeGreaterThanOrEqual(300);
    for (const c of data.sse) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const h of c.chunks as string[]) controller.enqueue(Uint8Array.from(Buffer.from(h, "hex")));
          controller.close();
        },
      });
      const frames: { event: string; data: string }[] = [];
      let error: string | undefined;
      try {
        for await (const f of c.max_frame_bytes === undefined ? parseSSE(body) : parseSSE(body, c.max_frame_bytes)) frames.push(f);
      } catch (e) {
        error = (e as { code?: string }).code;
      }
      expect(error === undefined ? { frames } : { frames, error }).toEqual(c.expect);
    }
  });
});
