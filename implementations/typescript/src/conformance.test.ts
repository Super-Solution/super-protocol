// The TypeScript reference must still produce every expectation in conformance/protocol.v1.json,
// the data the Go and Python ports are tested against. Regenerate with
// `pnpm build && pnpm conformance:export`
// when behaviour changes on purpose, then update every port.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_TOOL_PRESETS,
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

describe("conformance data", () => {
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
