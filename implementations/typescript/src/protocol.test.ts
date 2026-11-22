import { describe, expect, it } from "vitest";
import {
  CHART_CARD_KIND,
  EDITOR_CARD_KIND,
  PLOT_CARD_KIND,
  PLOT_FALLBACK_MESSAGE,
  PLOT_LIMITS,
  plotCardKind,
  validatePlotCardSpec,
  chartCardKind,
  validateChartAnnotations,
  validateChartCardSpec,
  GatewayError,
  collectText,
  editorCardKind,
  isTerminalEvent,
  parseSSE,
  validateChatPlugin,
  validateEditorCardSpec,
  CARD_PLACEMENTS,
  canPlaceCard,
  isCardPlacement,
  panelCardKinds,
  validatePluginManifest,
  PLUGIN_TOOL_PRESETS,
  THEME_TOKENS,
  isThemeValue,
  pluginToolAuthority,
  readHostTheme,
  themeTokenVariable,
  themeVariables,
  type ChatPlugin,
  type InferenceMessage,
  type InferenceRequest,
  type PluginTool,
  type StreamEvent,
} from "./index.js";

const manifest = {
  manifestVersion: 0 as const,
  name: "@supersolutions/super-editor-chat-plugin",
  version: "0.1.0",
  license: "GPL-3.0-or-later",
  capabilities: [{ id: "editor.document", surface: "card" as const, cardKind: EDITOR_CARD_KIND }],
};

describe("plugin manifest", () => {
  it("accepts a valid manifest", () => expect(validatePluginManifest(manifest)).toEqual([]));
  it("rejects non-objects", () => expect(validatePluginManifest(null)).toHaveLength(1));
  it("requires cardKind on card capabilities and toolName on tool capabilities", () => {
    const paths = validatePluginManifest({ ...manifest, capabilities: [{ id: "a.b", surface: "card" }, { id: "a.c", surface: "tool" }] }).map((i) => i.path);
    expect(paths).toEqual(["capabilities[0].cardKind", "capabilities[1].toolName"]);
  });
  it("reports duplicate ids and bad versions", () => {
    const paths = validatePluginManifest({ ...manifest, version: "x", capabilities: [manifest.capabilities[0], manifest.capabilities[0]] }).map((i) => i.path);
    expect(paths).toEqual(["version", "capabilities[1].id"]);
  });
  it("rejects a non-http service url", () => expect(validatePluginManifest({ ...manifest, service: { baseUrl: "ftp://x" } })[0]?.path).toBe("service.baseUrl"));
});

describe("card placement", () => {
  it("knows the three places", () => {
    expect(CARD_PLACEMENTS).toEqual(["inline", "panel", "document"]);
    expect(CARD_PLACEMENTS.every(isCardPlacement)).toBe(true);
    expect(isCardPlacement("side")).toBe(false);
  });
  it("keeps interactive cards inline", () => {
    expect(canPlaceCard({ interactive: true }, "inline")).toBe(true);
    expect(canPlaceCard({ interactive: true }, "panel")).toBe(false);
    expect(canPlaceCard({ interactive: true }, "document")).toBe(false);
    expect(canPlaceCard({}, "panel")).toBe(true);
    expect(canPlaceCard(undefined, "document")).toBe(true);
    expect(canPlaceCard({}, "window")).toBe(false);
  });
});

describe("chat plugin", () => {
  const mount = () => ({ update() {}, destroy() {} });
  const plugin: ChatPlugin = { manifest, cardKinds: [editorCardKind], mounts: { [EDITOR_CARD_KIND]: mount } };
  it("is loadable when every capability is implemented", () => expect(validateChatPlugin(plugin)).toEqual([]));
  it("flags a missing card kind and a missing mount", () => {
    expect(validateChatPlugin({ manifest }).map((i) => i.message)).toEqual([`plugin does not define card kind "${EDITOR_CARD_KIND}"`, `plugin has no mount for card kind "${EDITOR_CARD_KIND}"`]);
  });
  it("accepts a panel capability that names a card kind it mounts", () => {
    const m = { ...manifest, capabilities: [...manifest.capabilities, { id: "editor.panel", surface: "panel" as const, cardKind: EDITOR_CARD_KIND }] };
    expect(validateChatPlugin({ ...plugin, manifest: m })).toEqual([]);
    expect(panelCardKinds({ manifest: m })).toEqual([EDITOR_CARD_KIND]);
  });
  it("flags a panel capability whose card kind the plugin does not define", () => {
    const m = { ...manifest, capabilities: [...manifest.capabilities, { id: "editor.panel", surface: "panel" as const, cardKind: "x.other" }] };
    expect(validateChatPlugin({ ...plugin, manifest: m }).map((i) => i.path)).toEqual(["capabilities[1].cardKind", "capabilities[1].cardKind"]);
  });
  it("still accepts a bare panel capability, which names no card kind", () => {
    const m = { ...manifest, capabilities: [...manifest.capabilities, { id: "editor.panel", surface: "panel" as const }] };
    expect(validateChatPlugin({ ...plugin, manifest: m })).toEqual([]);
    expect(panelCardKinds({ manifest: m })).toEqual([]);
  });
  it("flags an undefined tool", () => {
    const m = { ...manifest, capabilities: [{ id: "x.run", surface: "tool" as const, toolName: "run" }] };
    expect(validateChatPlugin({ manifest: m })[0]?.path).toBe("capabilities[0].toolName");
  });
});

describe("editor card", () => {
  const document = { schemaVersion: 1 as const, id: "d", title: "T", blocks: [] };
  it("accepts an inline document or a service reference", () => {
    expect(validateEditorCardSpec({ kind: EDITOR_CARD_KIND, document })).toEqual({ ok: true });
    expect(validateEditorCardSpec({ kind: EDITOR_CARD_KIND, service: { baseUrl: "https://e.example.com", documentId: "d" } })).toEqual({ ok: true });
  });
  it("needs exactly one source", () => {
    expect(validateEditorCardSpec({ kind: EDITOR_CARD_KIND }).ok).toBe(false);
    expect(validateEditorCardSpec({ kind: EDITOR_CARD_KIND, document, service: { baseUrl: "https://x", documentId: "d" } }).ok).toBe(false);
  });
  it("keeps service-backed documents read-only", () => {
    expect(validateEditorCardSpec({ kind: EDITOR_CARD_KIND, service: { baseUrl: "https://e.example.com", documentId: "d" }, mode: "edit" }).ok).toBe(false);
  });
  it("rejects malformed documents, services and modes", () => {
    expect(validateEditorCardSpec({ kind: EDITOR_CARD_KIND, document: { schemaVersion: 2 } }).ok).toBe(false);
    expect(validateEditorCardSpec({ kind: EDITOR_CARD_KIND, service: { baseUrl: "nope", documentId: "d" } }).ok).toBe(false);
    expect(validateEditorCardSpec({ kind: EDITOR_CARD_KIND, document, mode: "write" }).ok).toBe(false);
    expect(validateEditorCardSpec({ kind: "other", document }).ok).toBe(false);
  });
});

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });

describe("router", () => {
  it("parses SSE across chunk and CRLF boundaries", async () => {
    const frames: { event: string; data: string }[] = [];
    for await (const f of parseSSE(stream(["event: output.delta\r\ndata: {\"a\"", ":1}\r\n\r\nevent: request.completed\ndata: {}\n", "\n"]))) frames.push(f);
    expect(frames).toEqual([{ event: "output.delta", data: '{"a":1}' }, { event: "request.completed", data: "{}" }]);
  });
  it("rejects oversized frames", async () => {
    await expect((async () => { for await (const _ of parseSSE(stream(["data: " + "x".repeat(50)]), 10)); })()).rejects.toBeInstanceOf(GatewayError);
  });
  const events = (types: StreamEvent[]) => (async function* () { yield* types; })();
  it("collects text and requires a terminal event", async () => {
    const delta = (text: string, sequence: number): StreamEvent => ({ type: "output.delta", request_id: "r", sequence, text });
    const done: StreamEvent = { type: "request.completed", request_id: "r", sequence: 3, execution_status: "succeeded", billing_status: "settled" };
    expect(await collectText(events([delta("Hel", 1), delta("lo", 2), done]))).toBe("Hello");
    await expect(collectText(events([delta("Hel", 1)]))).rejects.toMatchObject({ code: "stream_interrupted" });
    expect(isTerminalEvent(done)).toBe(true);
    expect(isTerminalEvent(delta("x", 1))).toBe(false);
  });
});

describe("chart", () => {
  const bar = (timestamp: number, close = 10) => ({ timestamp, open: 10, high: 12, low: 9, close });
  const base = { kind: CHART_CARD_KIND, symbol: { ticker: "BTCUSDT" }, period: { multiplier: 1, timespan: "hour", text: "1h" } };
  it("accepts inline bars or a feed reference, and exactly one of them", () => {
    expect(validateChartCardSpec({ ...base, bars: [bar(1), bar(2)] }).ok).toBe(true);
    expect(validateChartCardSpec({ ...base, feed: { id: "binance" } }).ok).toBe(true);
    expect(validateChartCardSpec(base).ok).toBe(false);
    expect(validateChartCardSpec({ ...base, bars: [bar(1)], feed: { id: "x" } }).ok).toBe(false);
    expect(chartCardKind.validate({ ...base, feed: { id: "x" } }).ok).toBe(true);
  });
  it("rejects unsorted, impossible or empty bars", () => {
    expect(validateChartCardSpec({ ...base, bars: [bar(2), bar(1)] }).ok).toBe(false);
    expect(validateChartCardSpec({ ...base, bars: [bar(1), bar(1)] }).ok).toBe(false);
    expect(validateChartCardSpec({ ...base, bars: [{ timestamp: 1, open: 10, high: 9, low: 8, close: 10 }] }).ok).toBe(false);
    expect(validateChartCardSpec({ ...base, bars: [] }).ok).toBe(false);
  });
  it("validates symbol, period, chart type and height", () => {
    expect(validateChartCardSpec({ ...base, feed: { id: "x" }, symbol: { ticker: "" } }).ok).toBe(false);
    expect(validateChartCardSpec({ ...base, feed: { id: "x" }, period: { multiplier: 0, timespan: "hour", text: "0h" } }).ok).toBe(false);
    expect(validateChartCardSpec({ ...base, feed: { id: "x" }, chartType: "renko" }).ok).toBe(false);
    expect(validateChartCardSpec({ ...base, feed: { id: "x" }, height: 10 }).ok).toBe(false);
  });
  it("checks the shape of each annotation kind and rejects duplicate keys", () => {
    const level = { key: "support", kind: "level", anchors: [{ time: 1, price: 9 }], tone: "bull" };
    const zone = { key: "ob", kind: "zone", anchors: [{ time: 1, price: 9 }, { time: 2, price: 11 }] };
    const marker = { key: "m", kind: "marker", anchors: [{ time: 1 }], text: "break" };
    expect(validateChartAnnotations([level, zone, marker])).toBeNull();
    expect(validateChartAnnotations([{ ...level, anchors: [{ time: 1 }] }])).not.toBeNull();
    expect(validateChartAnnotations([{ ...zone, anchors: [zone.anchors[0]] }])).not.toBeNull();
    expect(validateChartAnnotations([{ ...marker, tone: "purple" }])).not.toBeNull();
    expect(validateChartAnnotations([level, level])).toMatch(/duplicate/);
  });
});

describe("plugin tool authority", () => {
  const tool = (extra: Record<string, unknown>) => ({ name: "t", description: "d", inputSchema: { type: "object" }, run: async () => null, ...extra }) as PluginTool;
  const base = { manifest: { ...manifest, capabilities: [{ id: "x.run", surface: "tool" as const, toolName: "t" }] } };

  it("reads a declared authority", () => {
    for (const authority of ["read", "draft", "act"] as const) expect(pluginToolAuthority(tool({ authority }))).toBe(authority);
  });
  it("treats a missing or unknown authority as none", () => {
    expect(pluginToolAuthority(tool({}))).toBeNull();
    expect(pluginToolAuthority(tool({ authority: "admin" }))).toBeNull();
    expect(pluginToolAuthority(tool({ authority: "toString" }))).toBeNull();
    expect(pluginToolAuthority(tool({ authority: 1 }))).toBeNull();
  });
  it("still loads an older plugin that declares no authority", () => expect(validateChatPlugin({ ...base, tools: [tool({})] })).toEqual([]));
  it("refuses an unknown authority and a non-boolean confirm", () => {
    expect(validateChatPlugin({ ...base, tools: [tool({ authority: "admin" })] }).map((i) => i.path)).toEqual(["tools[0].authority"]);
    expect(validateChatPlugin({ ...base, tools: [tool({ authority: "act", confirm: "yes" })] }).map((i) => i.path)).toEqual(["tools[0].confirm"]);
  });
  it("grants each authority only to the presets at or above it", () => {
    expect(PLUGIN_TOOL_PRESETS.read).toEqual(["observer", "draft", "executor"]);
    expect(PLUGIN_TOOL_PRESETS.draft).toEqual(["draft", "executor"]);
    expect(PLUGIN_TOOL_PRESETS.act).toEqual(["executor"]);
  });
});

describe("host theme", () => {
  it("names one variable per token", () => {
    expect(themeTokenVariable("text-muted")).toBe("--super-text-muted");
    expect(new Set(THEME_TOKENS.map(themeTokenVariable)).size).toBe(THEME_TOKENS.length);
  });
  it("keeps valid tokens and drops unknown or unsafe ones individually", () => {
    const theme = readHostTheme({ mode: "dark", tokens: { background: " #000 ", text: "red; position:fixed", accent: "url(https://x.example/a)", nope: "#fff", border: 3 } });
    expect(theme).toEqual({ mode: "dark", tokens: { background: "#000" } });
  });
  it("refuses a theme without a known mode", () => {
    for (const value of [null, "dark", {}, { mode: "sepia", tokens: {} }]) expect(readHostTheme(value)).toBeNull();
  });
  it("accepts a theme with no tokens", () => expect(readHostTheme({ mode: "light" })).toEqual({ mode: "light", tokens: {} }));
  it("accepts real CSS values and rejects declaration breakers", () => {
    for (const ok of ["#0f1115", "rgb(1 2 3 / 50%)", "color-mix(in srgb, red 20%, transparent)", 'ui-sans-serif, "Segoe UI", sans-serif', "12px"]) expect(isThemeValue(ok)).toBe(true);
    for (const bad of ["", "  ", "a;b", "a}b", "/* x */", "@import 'x'", "x".repeat(257), 7, null]) expect(isThemeValue(bad)).toBe(false);
  });
  it("turns a theme into CSS variables without unsafe values", () => {
    expect(themeVariables({ mode: "light", tokens: { text: "#111", accent: "x;y" } })).toEqual({ "--super-text": "#111" });
  });
});

describe("inference request shapes", () => {
  it("keeps the original text message valid and adds the tool forms", () => {
    const messages: InferenceMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: [{ type: "text", text: "see" }, { type: "image", url: "https://e.example/a.png", detail: "low" }] },
      { role: "assistant", tool_calls: [{ id: "c1", name: "look", arguments: "{}" }] },
      { role: "tool", tool_call_id: "c1", content: "ok", is_error: false },
    ];
    const request: InferenceRequest = { service: "s", customer_id: "c", messages, tools: [{ name: "look", input_schema: { type: "object" } }], tool_choice: { name: "look" } };
    expect(request.messages).toHaveLength(4);
  });
  it("tool call events are not terminal", () => {
    expect(isTerminalEvent({ type: "output.tool_call.delta" })).toBe(false);
    expect(isTerminalEvent({ type: "output.tool_call.completed" })).toBe(false);
  });
  it("collectText ignores tool call events", async () => {
    const events: StreamEvent[] = [
      { type: "output.tool_call.delta", request_id: "r", sequence: 1, index: 0, id: "c", name: "n", arguments_delta: "{" },
      { type: "output.delta", request_id: "r", sequence: 2, text: "hi" },
      { type: "output.tool_call.completed", request_id: "r", sequence: 3, index: 0, id: "c", name: "n", arguments: "{}" },
      { type: "request.completed", request_id: "r", sequence: 4, execution_status: "succeeded", billing_status: "settled", finish_reason: "tool_calls" },
    ];
    expect(await collectText((async function* () { yield* events; })())).toBe("hi");
  });
});

describe("plot", () => {
  const base = { kind: PLOT_CARD_KIND, spec: { type: "bar", data: [{ a: 1 }] }, alt: "One bar of height 1." };
  it("wraps any plot spec without reading it", () => {
    expect(validatePlotCardSpec(base).ok).toBe(true);
    expect(validatePlotCardSpec({ ...base, spec: {} }).ok).toBe(true);
    expect(validatePlotCardSpec({ ...base, spec: { a_future_chart: { nobody: "knows" } } }).ok).toBe(true);
    expect(plotCardKind.validate({ ...base, id: "p1", title: "T", height: 300 }).ok).toBe(true);
  });
  it("requires a spec object and a non-empty alt, and tells the model what to send", () => {
    const noSpec = validatePlotCardSpec({ kind: PLOT_CARD_KIND, alt: "x" });
    expect(noSpec).toMatchObject({ ok: false, expected: expect.stringContaining("spec") });
    expect(validatePlotCardSpec({ ...base, spec: [] }).ok).toBe(false);
    expect(validatePlotCardSpec({ ...base, spec: null }).ok).toBe(false);
    expect(validatePlotCardSpec({ kind: PLOT_CARD_KIND, spec: {} })).toMatchObject({ ok: false, expected: expect.stringContaining("alt") });
    expect(validatePlotCardSpec({ ...base, alt: "   " }).ok).toBe(false);
    expect(validatePlotCardSpec({ ...base, alt: "a".repeat(PLOT_LIMITS.alt + 1) }).ok).toBe(false);
    expect(validatePlotCardSpec({ ...base, alt: "a".repeat(PLOT_LIMITS.alt) }).ok).toBe(true);
  });
  it("checks the envelope fields and the kind", () => {
    expect(validatePlotCardSpec({ ...base, kind: CHART_CARD_KIND }).ok).toBe(false);
    expect(validatePlotCardSpec({ ...base, id: "" }).ok).toBe(false);
    expect(validatePlotCardSpec({ ...base, height: 10 }).ok).toBe(false);
    expect(validatePlotCardSpec({ ...base, title: 3 }).ok).toBe(false);
    expect(validatePlotCardSpec(null).ok).toBe(false);
  });
  it("describes itself to a model", () => {
    expect(plotCardKind.kind).toBe(PLOT_CARD_KIND);
    expect(plotCardKind.schema.required).toEqual(["kind", "spec", "alt"]);
  });
  it("gives the user a plain fallback with no internals in it", () => {
    expect(PLOT_FALLBACK_MESSAGE).toBe("This chart can't be shown here.");
    expect(PLOT_FALLBACK_MESSAGE).not.toMatch(/super\.plot|spec|render|mount|json|error/i);
  });
});
