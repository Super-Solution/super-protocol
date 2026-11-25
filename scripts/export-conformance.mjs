// Writes conformance/protocol.v1.json: language-neutral cases generated from the TypeScript
// reference in implementations/typescript/ (plugin manifest, editor, chart and plot card specs, SSE parser,
// terminal-event check, run events). Go and Python must reproduce every case exactly.
//
// Run `pnpm build` first: the generator imports the built
// package. implementations/typescript/src/conformance.test.ts fails if the file drifts from the reference.
import { writeFileSync } from "node:fs";
import {
  ISSUE_CODES,
  PLUGIN_TOOL_PRESETS,
  THEME_TOKENS,
  didYouMean,
  formatCardRef,
  inferenceStreamOutcome,
  panelCardKinds,
  pluginToolAuthority,
  readHostTheme,
  themeVariables,
  validateChatPlugin,
  validateInferenceMessage,
  validateInferenceRequest,
  validateStreamEvent,
  isRunEventType,
  isRunTerminalEvent,
  isTerminalEvent,
  isCardPlacement,
  canPlaceCard,
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
} from "../implementations/typescript/dist/index.js";

let seed = 20261108;
const rand = (n) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed % n);
const pick = (items) => items[rand(items.length)];
const clone = (v) => JSON.parse(JSON.stringify(v));
/** A deep copy of `base` after `fn` edited it; `fn` returns nothing. */
const mut = (base, fn) => {
  const c = clone(base);
  fn(c);
  return c;
};

// ---- plugin manifest -------------------------------------------------------------------------
const manifest = {
  manifestVersion: 0,
  name: "@supersolutions/super-editor-chat-plugin",
  version: "0.1.0",
  license: "GPL-3.0-or-later",
  capabilities: [
    { id: "editor.document", surface: "card", cardKind: "super-editor.document" },
    { id: "editor.open-tool", surface: "tool", toolName: "open_document", inputSchema: { type: "object" } },
    { id: "editor.side-panel", surface: "panel" },
    { id: "editor.canvas", surface: "canvas" },
  ],
  service: { baseUrl: "https://editor.example.com" },
};
const manifests = [
  manifest,
  mut(manifest, (m) => delete m.service),
  mut(manifest, (m) => (m.capabilities = [m.capabilities[0]])),
  mut(manifest, (m) => (m.manifestVersion = 1)),
  mut(manifest, (m) => delete m.manifestVersion),
  mut(manifest, (m) => (m.manifestVersion = "0")),
  null,
  [],
  "manifest",
  42,
  {},
];
for (const name of [
  "plain",
  "@scope/pkg",
  "@scope/pkg.name-x_y",
  "a",
  "~tilde",
  "UPPER",
  "@Scope/pkg",
  "@scope",
  "@/pkg",
  "a b",
  "",
  "a/b",
  "@a/b/c",
  ".dot",
  "-dash",
  "pkg~",
  7,
  null,
])
  manifests.push(mut(manifest, (m) => (m.name = name)));
for (const version of [
  "1.0.0",
  "0.0.0",
  "10.20.30",
  "1.0.0-beta.1",
  "1.0.0+build.5",
  "1.0.0-rc.1+sha.abc",
  "01.0.0",
  "1.0",
  "1",
  "v1.0.0",
  "1.0.0.0",
  "1.0.0-",
  "1.0.0-bad_char",
  "",
  " 1.0.0",
  1,
  null,
])
  manifests.push(mut(manifest, (m) => (m.version = version)));
for (const license of ["MIT", "GPL-3.0-or-later", "Apache-2.0 OR MIT", "", "   ", "\t", 3, null])
  manifests.push(mut(manifest, (m) => (m.license = license)));
for (const caps of [
  [],
  "x",
  null,
  {},
  [null],
  ["x"],
  [[]],
  [{ id: "editor.document", surface: "card", cardKind: "k" }, { id: "editor.document", surface: "panel" }],
  [{ id: "a.b", surface: "panel" }, { id: "a.c", surface: "panel" }],
  [{ id: "Editor.document", surface: "panel" }],
  [{ id: "editor", surface: "panel" }],
  [{ id: "editor.", surface: "panel" }],
  [{ id: "a.b.c.d", surface: "panel" }],
  [{ id: "1a.b", surface: "panel" }],
  [{ id: "a-b.c-d", surface: "panel" }],
  [{ id: "a.b c", surface: "panel" }],
  [{ id: 5, surface: "panel" }],
  [{ surface: "panel" }],
  [{ id: "a.b" }],
  [{ id: "a.b", surface: "window" }],
  [{ id: "a.b", surface: 1 }],
  [{ id: "a.b", surface: "card" }],
  [{ id: "a.b", surface: "card", cardKind: "" }],
  [{ id: "a.b", surface: "card", cardKind: 3 }],
  [{ id: "a.b", surface: "tool" }],
  [{ id: "a.b", surface: "tool", toolName: "" }],
  [{ id: "a.b", surface: "tool", toolName: "t" }],
  [{ id: "a.b", surface: "panel", inputSchema: [] }],
  [{ id: "a.b", surface: "panel", inputSchema: null }],
  [{ id: "a.b", surface: "panel", inputSchema: "s" }],
  [{ id: "a.b", surface: "panel", inputSchema: {} }],
  [{ id: "a.b", surface: "card" }, { id: "a.b", surface: "tool" }, { surface: "x" }],
  [{ id: "a.b", surface: "panel", cardKind: "super-editor.document" }],
  [{ id: "a.b", surface: "panel", cardKind: "" }],
  [{ id: "a.b", surface: "panel", cardKind: 3 }],
  [{ id: "a.b", surface: "panel", cardKind: null }],
  [{ id: "a.b", surface: "card", cardKind: "k" }, { id: "a.c", surface: "panel", cardKind: "k" }],
])
  manifests.push(mut(manifest, (m) => (m.capabilities = caps)));
for (const service of [
  null,
  "https://x.com",
  [],
  {},
  { baseUrl: 3 },
  { baseUrl: "" },
  { baseUrl: "http://localhost:8080/path?q=1#frag" },
  { baseUrl: "https://user:pw@host.example/" },
  { baseUrl: "HTTPS://EXAMPLE.COM" },
  { baseUrl: "http://[::1]:8080" },
  { baseUrl: "http://192.168.0.1:3000" },
  { baseUrl: "http://example.com:99999" },
  { baseUrl: "http://example.com:abc" },
  { baseUrl: "http://exa mple.com" },
  { baseUrl: "ftp://example.com" },
  { baseUrl: "ws://example.com" },
  { baseUrl: "javascript:alert(1)" },
  { baseUrl: "file:///etc/passwd" },
  { baseUrl: "//example.com" },
  { baseUrl: "example.com" },
  { baseUrl: "not a url" },
  { baseUrl: "http://" },
  { baseUrl: "https:///path" },
  { baseUrl: "http://a" },
  { baseUrl: "https://xn--nxasmq6b.example" },
  { baseUrl: "https://example.com", extra: true },
])
  manifests.push(mut(manifest, (m) => (m.service = service)));
// A typo near a valid word gets a "did you mean" hint, and several problems come back together.
manifests.push(
  mut(manifest, (m) => (m.capabilities[0].surface = "cardd")),
  mut(manifest, (m) => (m.capabilities[1].surface = "tol")),
  mut(manifest, (m) => ((m.name = 5), (m.version = "1"), (m.license = " "), (m.capabilities = []))),
  mut(manifest, (m) => ((m.manifestVersion = 2), (m.service = { baseUrl: 3 }), (m.capabilities = [null, { id: "x", surface: "bogus" }]))),
);
const manifestCases = manifests.map((value) => ({ value, expect: validatePluginManifest(value) }));

// ---- editor card -----------------------------------------------------------------------------
const doc = { schemaVersion: 1, id: "d1", title: "T", blocks: [] };
const editor = { kind: "super-editor.document", title: "A", mode: "edit", document: doc };
const editors = [
  editor,
  mut(editor, (s) => delete s.title),
  mut(editor, (s) => delete s.mode),
  mut(editor, (s) => (s.mode = "view")),
  mut(editor, (s) => (s.mode = "write")),
  mut(editor, (s) => (s.title = 5)),
  mut(editor, (s) => (s.kind = "other")),
  mut(editor, (s) => delete s.kind),
  mut(editor, (s) => delete s.document),
  mut(editor, (s) => (s.service = { baseUrl: "https://e.example", documentId: "x" })),
  { kind: "super-editor.document", service: { baseUrl: "https://e.example", documentId: "x" } },
  { kind: "super-editor.document", mode: "view", service: { baseUrl: "https://e.example", documentId: "x" } },
  { kind: "super-editor.document", mode: "edit", service: { baseUrl: "https://e.example", documentId: "x" } },
  { kind: "super-editor.document", service: { baseUrl: "https://e.example", documentId: "" } },
  { kind: "super-editor.document", service: { baseUrl: "ftp://e.example", documentId: "x" } },
  { kind: "super-editor.document", service: { baseUrl: "nope", documentId: "x" } },
  { kind: "super-editor.document", service: { baseUrl: "https://e.example" } },
  { kind: "super-editor.document", service: { documentId: "x" } },
  { kind: "super-editor.document", service: null },
  { kind: "super-editor.document", service: "s" },
  { kind: "super-editor.document", service: [] },
  { kind: "super-editor.document", document: null },
  { kind: "super-editor.document", document: [] },
  { kind: "super-editor.document", document: "d" },
  { kind: "super-editor.document", document: { ...doc, schemaVersion: 2 } },
  { kind: "super-editor.document", document: { ...doc, schemaVersion: "1" } },
  { kind: "super-editor.document", document: { ...doc, id: 1 } },
  { kind: "super-editor.document", document: { ...doc, title: null } },
  { kind: "super-editor.document", document: { ...doc, blocks: {} } },
  { kind: "super-editor.document", document: { schemaVersion: 1, id: "d", title: "t" } },
  { kind: "super-editor.document", document: { ...doc, extra: [1, 2] } },
  { kind: "super-editor.document", document: doc, service: { baseUrl: "https://e.example", documentId: "x" } },
  null,
  [],
  "x",
  7,
  {},
];
editors.push(
  mut(editor, (s) => (s.mode = "veiw")),
  mut(editor, (s) => ((s.kind = 3), (s.title = 4), (s.mode = "x"), delete s.document)),
  { kind: "super-editor.document", mode: "edit", service: { baseUrl: "nope", documentId: "" }, document: { schemaVersion: 2 } },
);
const editorCases = editors.map((value) => ({ value, expect: validateEditorCardSpec(value) }));

// ---- chart card ------------------------------------------------------------------------------
const bar = (t, o, h, l, c, v) => (v === undefined ? { timestamp: t, open: o, high: h, low: l, close: c } : { timestamp: t, open: o, high: h, low: l, close: c, volume: v });
const chart = {
  kind: "super-chart.chart",
  id: "c1",
  title: "BTC",
  symbol: { ticker: "BTCUSDT", name: "Bitcoin", pricePrecision: 2 },
  period: { multiplier: 1, timespan: "day", text: "1D" },
  height: 420,
  chartType: "candles",
  bars: [bar(1000, 10, 12, 9, 11, 100), bar(2000, 11, 13, 10, 12), bar(3000, 12, 12, 12, 12, 0)],
  indicators: [{ name: "MA", params: [5, 10] }, { name: "RSI" }],
  annotations: [
    { key: "a1", kind: "level", anchors: [{ time: 1000, price: 10 }], text: "support", tone: "bull" },
    { key: "a2", kind: "zone", anchors: [{ time: 1000, price: 9 }, { time: 3000, price: 13 }], color: "#fff" },
    { key: "a3", kind: "marker", anchors: [{ time: 2000 }] },
  ],
};
const charts = [
  chart,
  mut(chart, (s) => delete s.id),
  mut(chart, (s) => delete s.title),
  mut(chart, (s) => delete s.height),
  mut(chart, (s) => delete s.chartType),
  mut(chart, (s) => delete s.indicators),
  mut(chart, (s) => delete s.annotations),
  mut(chart, (s) => (s.kind = "x")),
  mut(chart, (s) => (s.id = "")),
  mut(chart, (s) => (s.id = "  ")),
  mut(chart, (s) => (s.id = "x".repeat(128))),
  mut(chart, (s) => (s.id = "x".repeat(129))),
  mut(chart, (s) => (s.id = 5)),
  mut(chart, (s) => (s.title = 5)),
];
for (const symbol of [
  undefined,
  null,
  [],
  "BTC",
  {},
  { ticker: "" },
  { ticker: "  " },
  { ticker: 3 },
  { ticker: "A", name: 1 },
  { ticker: "A", logo: "u", timezone: "UTC", exchange: "X", market: "m", priceCurrency: "USD", type: "t", shortName: "s" },
  { ticker: "A", timezone: 5 },
  { ticker: "A", pricePrecision: "auto" },
  { ticker: "A", pricePrecision: 0 },
  { ticker: "A", pricePrecision: 12 },
  { ticker: "A", pricePrecision: 13 },
  { ticker: "A", pricePrecision: -1 },
  { ticker: "A", pricePrecision: 1.5 },
  { ticker: "A", pricePrecision: "2" },
  { ticker: "A", pricePrecision: null },
])
  charts.push(mut(chart, (s) => (symbol === undefined ? delete s.symbol : (s.symbol = symbol))));
for (const period of [
  undefined,
  null,
  [],
  {},
  { multiplier: 0, timespan: "day", text: "x" },
  { multiplier: -1, timespan: "day", text: "x" },
  { multiplier: 1.5, timespan: "day", text: "x" },
  { multiplier: "1", timespan: "day", text: "x" },
  { multiplier: 9007199254740991, timespan: "day", text: "x" },
  { multiplier: 9007199254740992, timespan: "day", text: "x" },
  { multiplier: 5, timespan: "", text: "x" },
  { multiplier: 5, timespan: " ", text: "x" },
  { multiplier: 5, timespan: 1, text: "x" },
  { multiplier: 5, timespan: "minute", text: "" },
  { multiplier: 5, timespan: "minute", text: "5m" },
])
  charts.push(mut(chart, (s) => (period === undefined ? delete s.period : (s.period = period))));
for (const height of [159, 160, 420, 1200, 1201, "420", null, 300.5, -5, 0])
  charts.push(mut(chart, (s) => (s.height = height)));
for (const t of ["candles", "hollow-candles", "ohlc", "line", "area", "baseline", "heikin-ashi", "renko", "", 1, null])
  charts.push(mut(chart, (s) => (s.chartType = t)));
// bars xor feed, and bar shape
charts.push(mut(chart, (s) => ((s.feed = { id: "f" }), 0)));
charts.push(mut(chart, (s) => (delete s.bars, (s.feed = { id: "f" }))));
for (const feed of [{ id: "" }, { id: "  " }, { id: 1 }, {}, null, "f", []])
  charts.push(mut(chart, (s) => (delete s.bars, (s.feed = feed))));
charts.push(mut(chart, (s) => delete s.bars));
for (const bars of [
  [],
  null,
  "x",
  {},
  [null],
  [1],
  [bar(1, 1, 1, 1, 1)],
  [bar(2, 1, 1, 1, 1), bar(1, 1, 1, 1, 1)],
  [bar(1, 1, 1, 1, 1), bar(1, 1, 1, 1, 1)],
  [bar(1, 1, 2, 0, 1), bar(2, 1, 2, 0, 1), bar(3, 1, 2, 0, 1)],
  [bar(1, 5, 4, 1, 3)],
  [bar(1, 5, 6, 5.5, 5.8)],
  [bar(1, 5, 6, 4, 7)],
  [bar(1, 5, 6, 4, 3)],
  [bar(1, 5, 6, 4, 5)],
  [bar(1, 5, 5, 5, 5)],
  [{ timestamp: 1, open: 1, high: 1, low: 1 }],
  [{ timestamp: "1", open: 1, high: 1, low: 1, close: 1 }],
  [{ timestamp: 1, open: null, high: 1, low: 1, close: 1 }],
  [{ ...bar(1, 1, 1, 1, 1), volume: "10" }],
  [{ ...bar(1, 1, 1, 1, 1), volume: null }],
  [bar(1, 1, 1, 1, 1, 7)],
  [bar(-5, 1, 1, 1, 1), bar(0, 1, 1, 1, 1), bar(1.5, 1, 1, 1, 1)],
  [bar(1e15, 1e300, 1e300, 1e-300, 1e300)],
  [{ ...bar(1, 1, 1, 1, 1), extra: true }],
])
  charts.push(mut(chart, (s) => (s.bars = bars)));
// random valid and slightly broken bar series
for (let n = 0; n < 30; n++) {
  const bars = [];
  let t = rand(5000) - 2000;
  for (let i = 0; i < 1 + rand(8); i++) {
    t += 1 + rand(3600);
    const o = rand(1000) / 8,
      c = rand(1000) / 8;
    const h = Math.max(o, c) + rand(50) / 8,
      l = Math.min(o, c) - rand(50) / 8;
    bars.push(rand(10) === 0 ? bar(t, o, h, l, c, rand(1e6)) : bar(t, o, h, l, c));
  }
  if (n % 3 === 1 && bars.length > 1) bars[1].timestamp = bars[0].timestamp - rand(2);
  if (n % 3 === 2) bars[bars.length - 1].high = Math.min(bars[bars.length - 1].open, bars[bars.length - 1].close) - 1;
  charts.push(mut(chart, (s) => (s.bars = bars)));
}
// indicators
const many = (k) => Array.from({ length: k }, (_, i) => ({ name: "I" + i }));
for (const indicators of [
  [],
  many(12),
  many(13),
  null,
  "MA",
  {},
  [null],
  ["MA"],
  [{}],
  [{ name: "" }],
  [{ name: " " }],
  [{ name: 1 }],
  [{ name: "MA", params: [] }],
  [{ name: "MA", params: [1, 2.5, -3] }],
  [{ name: "MA", params: "5" }],
  [{ name: "MA", params: [1, "2"] }],
  [{ name: "MA", params: [1, null] }],
  [{ name: "MA", params: {} }],
])
  charts.push(mut(chart, (s) => (s.indicators = indicators)));
// annotations
const lvl = (key, extra = {}) => ({ key, kind: "level", anchors: [{ time: 1, price: 2 }], ...extra });
const manyAnn = (k) => Array.from({ length: k }, (_, i) => lvl("k" + i));
for (const annotations of [
  [],
  manyAnn(256),
  manyAnn(257),
  null,
  "a",
  {},
  [null],
  [1],
  [[]],
  [lvl("")],
  [lvl("  ")],
  [lvl("x".repeat(128))],
  [lvl("x".repeat(129))],
  [lvl("😀".repeat(64))],
  [lvl("😀".repeat(65))],
  [lvl(5)],
  [lvl("a"), lvl("a")],
  [lvl("a"), lvl("b")],
  [{ key: "a", kind: "line", anchors: [{ time: 1, price: 2 }] }],
  [{ key: "a", anchors: [{ time: 1, price: 2 }] }],
  [{ key: "a", kind: "level" }],
  [{ key: "a", kind: "level", anchors: [] }],
  [{ key: "a", kind: "level", anchors: "x" }],
  [{ key: "a", kind: "level", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }, { time: 3, price: 4 }] }],
  [{ key: "a", kind: "level", anchors: [{ time: 1 }] }],
  [{ key: "a", kind: "level", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }] }],
  [{ key: "a", kind: "level", anchors: [{ price: 2 }] }],
  [{ key: "a", kind: "level", anchors: [{ time: "1", price: 2 }] }],
  [{ key: "a", kind: "level", anchors: [{ time: 1, price: "2" }] }],
  [{ key: "a", kind: "level", anchors: [{ time: 1, price: null }] }],
  [{ key: "a", kind: "level", anchors: [null] }],
  [{ key: "a", kind: "level", anchors: [[]] }],
  [{ key: "a", kind: "zone", anchors: [{ time: 1, price: 2 }] }],
  [{ key: "a", kind: "zone", anchors: [{ time: 1, price: 2 }, { time: 2 }] }],
  [{ key: "a", kind: "zone", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }] }],
  [{ key: "a", kind: "marker", anchors: [{ time: 1 }] }],
  [{ key: "a", kind: "marker", anchors: [{ time: 1, price: 5 }] }],
  [{ key: "a", kind: "marker", anchors: [{ time: 1 }, { time: 2 }] }],
  [lvl("a", { text: "t".repeat(2048) })],
  [lvl("a", { text: "t".repeat(2049) })],
  [lvl("a", { text: "😀".repeat(1024) })],
  [lvl("a", { text: "😀".repeat(1025) })],
  [lvl("a", { text: 5 })],
  [lvl("a", { text: "" })],
  [lvl("a", { tone: "bull" })],
  [lvl("a", { tone: "bear" })],
  [lvl("a", { tone: "neutral" })],
  [lvl("a", { tone: "accent" })],
  [lvl("a", { tone: "loud" })],
  [lvl("a", { tone: 1 })],
  [lvl("a", { color: "red" })],
  [lvl("a", { color: "c".repeat(128) })],
  [lvl("a", { color: "c".repeat(129) })],
  [lvl("a", { color: 5 })],
  // trend, ray, fibonacci and plan
  ...["trend", "ray", "fibonacci"].flatMap((kind) => [
    [{ key: "a", kind, anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }] }],
    [{ key: "a", kind, anchors: [{ time: 1, price: 2 }] }],
    [{ key: "a", kind, anchors: [{ time: 1, price: 2 }, { time: 2 }] }],
    [{ key: "a", kind, anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }, { time: 3, price: 4 }] }],
    [{ key: "a", kind, anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { extend: "right" } }],
  ]),
  [{ key: "a", kind: "plan", anchors: [{ time: 1, price: 10 }, { time: 5, price: 12 }, { time: 1, price: 9 }], text: "Long" }],
  [{ key: "a", kind: "plan", anchors: [{ time: 1, price: 10 }, { time: 5, price: 12 }] }],
  [{ key: "a", kind: "plan", anchors: [{ time: 1, price: 10 }, { time: 5, price: 12 }, { time: 1 }] }],
  [{ key: "a", kind: "plan", anchors: [{ time: 1, price: 10 }, { time: 5, price: 12 }, { time: 1, price: 9 }, { time: 2, price: 9 }] }],
  [{ key: "a", kind: "fibonacci", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { levels: "0,0.5,1", prices: false, width: 2 } }],
  // params
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: {} }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: [] }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: null }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: "x" }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { x: null } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { x: [1] } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { x: "s".repeat(128) } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { x: "s".repeat(129) } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { x: "😀".repeat(64) } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { x: "😀".repeat(65) } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { "1x": 1 } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { "": 1 } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { ["k".repeat(32)]: 1 } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { ["k".repeat(33)]: 1 } }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: Object.fromEntries(Array.from({ length: 16 }, (_, i) => ["p" + i, i])) }],
  [{ key: "a", kind: "trend", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ["p" + i, i])) }],
  [lvl("a", { params: { x: 1 } })],
  [lvl("a", { params: {} })],
  [{ key: "a", kind: "zone", anchors: [{ time: 1, price: 2 }, { time: 2, price: 3 }], params: { x: 1 } }],
  [{ key: "a", kind: "marker", anchors: [{ time: 1 }], params: { x: 1 } }],
])
  charts.push(mut(chart, (s) => (s.annotations = annotations)));
charts.push(null, [], "x", 3, {}, { kind: "super-chart.chart" });
charts.push(
  mut(chart, (s) => (s.chartType = "candle")),
  mut(chart, (s) => ((s.id = ""), (s.title = 1), (s.symbol = {}), (s.period = {}), (s.height = 5), (s.chartType = "x"))),
  mut(chart, (s) => (s.bars = [bar(2000, 1, 2, 3, 4), bar(1000, "x", 2, 1, 1), bar(1000, 1, 2, 1, 1), null])),
  mut(chart, (s) => (s.annotations = [lvl("a", { tone: "bul", color: 5 }), lvl("a", { text: 5 }), { key: 1, kind: "zone", anchors: [{ time: "x" }, null, { time: 1, price: "p" }] }])),
  mut(chart, (s) => ((s.indicators = [null, { name: "", params: [1, "x"] }, { params: 3 }]), (s.feed = { id: " " }))),
);
const chartCases = charts.map((value) => ({ value, expect: validateChartCardSpec(value) }));

// ---- plot card -------------------------------------------------------------------------------
const plot = {
  kind: "super.plot",
  id: "p1",
  title: "Revenue by region",
  height: 360,
  spec: { type: "bar", data: [{ region: "EU", revenue: 12 }, { region: "US", revenue: 20 }], x: "region", y: "revenue" },
  alt: "Bar chart of revenue by region: the US leads with 20, the EU follows with 12.",
};
const plots = [
  plot,
  mut(plot, (s) => delete s.id),
  mut(plot, (s) => delete s.title),
  mut(plot, (s) => delete s.height),
  mut(plot, (s) => (s.spec = {})),
  mut(plot, (s) => (s.spec = { anything: [1, "two", null, { deep: true }], nested: { a: { b: { c: 1 } } } })),
  mut(plot, (s) => (s.extra = "ignored")),
  mut(plot, (s) => (s.kind = "super-chart.chart")),
  mut(plot, (s) => (s.kind = "plot")),
  mut(plot, (s) => delete s.kind),
];
for (const id of ["", "  ", "x".repeat(128), "x".repeat(129), "😀".repeat(64), "😀".repeat(65), 5, null])
  plots.push(mut(plot, (s) => (s.id = id)));
for (const title of ["", 5, null, []]) plots.push(mut(plot, (s) => (s.title = title)));
for (const height of [159, 160, 360, 1200, 1201, "360", null, 300.5, -5, 0])
  plots.push(mut(plot, (s) => (s.height = height)));
for (const spec of [undefined, null, [], [1, 2], "bar", 5, true])
  plots.push(mut(plot, (s) => (spec === undefined ? delete s.spec : (s.spec = spec))));
for (const alt of [undefined, null, "", "   ", "\t\n", 5, [], {}, "a", "a".repeat(2048), "a".repeat(2049), "😀".repeat(1024), "😀".repeat(1025), "é日本語"])
  plots.push(mut(plot, (s) => (alt === undefined ? delete s.alt : (s.alt = alt))));
plots.push(mut(plot, (s) => (delete s.spec, delete s.alt)));
plots.push(mut(plot, (s) => (s.spec = null, s.alt = null)));
plots.push(null, [], "x", 3, true, {}, { kind: "super.plot" }, { kind: "super.plot", spec: {} }, { kind: "super.plot", alt: "a" });
plots.push(mut(plot, (s) => ((s.kind = "super.plt"), (s.id = ""), (s.title = 1), (s.height = 1), (s.spec = 1), (s.alt = ""))));
const plotCases = plots.map((value) => ({ value, expect: validatePlotCardSpec(value) }));

// ---- terminal events -------------------------------------------------------------------------
const terminalCases = [
  "request.started",
  "output.delta",
  "request.completed",
  "request.failed",
  "request.replayed",
  "",
  "request.Completed",
  "x",
].map((type) => ({ type, expect: isTerminalEvent({ type }) }));

// ---- run events ------------------------------------------------------------------------------
const runUsage = { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cachedInputTokens: 900, reasoningTokens: 0 };
const runAction = { cardId: "card_1", callId: "call_1", kind: "confirm", type: "confirm", value: { note: "ok" }, at: 1767225600000 };
const runCard = { id: "card_1", spec: { kind: "confirm", title: "Send the email?" }, callId: "call_1" };
const runParts = [{ type: "text", text: "Here is the plan." }];
const runHandle = { provider: "openai", id: "resp_1", model: "m", createdAt: 1767225600000 };
/** One valid event of every type; every other case is one of these with one thing changed. */
const runEvents = [
  { type: "run-start", runId: "run_1", mode: "stream" },
  { type: "run-snapshot", parts: runParts, cards: [{ ...runCard, action: runAction, expired: false }], usage: runUsage, steps: 2 },
  { type: "context-built", trace: { layers: [] }, system: "You are helpful.", toolNames: ["search", "send_email"] },
  { type: "step-start", step: 0 },
  { type: "text-delta", delta: "Hel" },
  { type: "reasoning-delta", delta: "" },
  { type: "tool-call-input-delta", callId: "call_1", name: "search", partialInput: { query: "x" }, partialCard: { kind: "table" }, loading: { kind: "table", label: "Searching" } },
  { type: "tool-call", callId: "call_1", name: "search", input: { query: "x" }, repaired: true, loading: { kind: "generic", label: "Searching" } },
  { type: "awaiting-user", callId: "call_1", card: runCard },
  { type: "user-responded", callId: "call_1", action: runAction },
  { type: "tool-result", callId: "call_1", name: "search", output: { hits: 3 }, failure: "timeout", ms: 412.5 },
  { type: "card", card: runCard },
  { type: "card-updated", cardId: "card_1", spec: { kind: "progress", value: 0.5 } },
  { type: "step-finish", step: 1, finishReason: "tool-calls", usage: runUsage },
  { type: "job-started", handle: runHandle },
  { type: "job-status", handle: runHandle, status: "in_progress" },
  { type: "message", parts: runParts },
  { type: "metering", record: { id: "run_1:0", scope: "step" } },
  { type: "usage", usage: runUsage },
  { type: "run-finish", runId: "run_1", finishReason: "stop", usage: runUsage, steps: 2 },
  { type: "error", error: { message: "The model did not answer." }, recoverable: false },
];
const runJunk = [null, true, -1, 1.5, "", "x", [], {}];
/** Fields the protocol does not look inside: changed as a whole, never field by field. */
const runOpaque = ["input", "partialInput", "output", "error", "trace", "record", "value", "loading", "text"];
/** Every place inside an event a check looks at, as a path of keys and indexes. */
const runPaths = (value, path = []) => {
  if (value === null || typeof value !== "object" || runOpaque.includes(path[path.length - 1])) return [path];
  const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
  return [path, ...keys.flatMap((k) => runPaths(value[k], [...path, k]))];
};
const runAt = (root, path) => path.slice(0, -1).reduce((v, k) => v[k], root);
const runOptional = { "run-snapshot": ["usage", "steps"], "tool-call-input-delta": ["partialCard", "loading"], "tool-call": ["repaired", "loading"], "tool-result": ["failure"], "step-finish": ["usage"] };
const runEventValues = [...runEvents];
for (const base of runEvents) {
  // The least a valid event may carry: every optional field left out.
  if (runOptional[base.type]) runEventValues.push(mut(base, (e) => runOptional[base.type].forEach((k) => delete e[k])));
  for (const path of runPaths(base).filter((p) => p.length > 0 && p.join(".") !== "type")) {
    const key = path[path.length - 1];
    if (typeof key === "string") runEventValues.push(mut(base, (e) => delete runAt(e, path)[key]));
    for (const junk of runJunk) runEventValues.push(mut(base, (e) => (runAt(e, path)[key] = junk)));
  }
}
for (const mode of ["stream", "sync", "background", "Stream", "batch"]) runEventValues.push({ type: "run-start", runId: "r", mode });
for (const finishReason of ["stop", "length", "tool-calls", "content-filter", "cancelled", "error", "unknown", "tool_calls", "done"])
  runEventValues.push({ type: "run-finish", runId: "r", finishReason, usage: {}, steps: 0 });
for (const status of ["queued", "in_progress", "completed", "failed", "cancelled", "incomplete", "running"])
  runEventValues.push({ type: "job-status", handle: { provider: "p", id: "j" }, status });
for (const type of ["submit", "select", "confirm", "cancel", "dismiss", "approve"])
  runEventValues.push({ type: "user-responded", callId: "c", action: { cardId: "k", kind: "confirm", type, at: 0 } });
runEventValues.push(
  null,
  [],
  "run-start",
  42,
  true,
  {},
  { type: null },
  { type: 7 },
  { type: "" },
  { type: "resync" },
  { type: "done" },
  { type: "Run-Start", runId: "r", mode: "stream" },
  { type: "request.completed" },
  [{ type: "run-start", runId: "r", mode: "stream" }],
  { type: "run-snapshot", parts: [], cards: [] },
  { type: "run-snapshot", parts: [{ type: "text" }, null, { type: 1 }, [], "x"], cards: [null, { id: "", spec: null }, { id: "c", spec: { kind: "k" }, action: { at: -1 } }] },
  { type: "context-built", trace: {}, system: "", toolNames: [] },
  { type: "context-built", trace: [], system: null, toolNames: ["a", 1, null, ""] },
  { type: "usage", usage: { inputTokens: 0.5, outputTokens: -1, totalTokens: "3", cachedInputTokens: null, reasoningTokens: true, other: "ignored" } },
  { type: "tool-result", callId: "c", name: "n", ms: 0 },
  { type: "tool-result", callId: "c", name: "n", ms: -0.001 },
  { type: "error", recoverable: true },
  { type: "error", error: "boom", recoverable: "no" },
  { type: "text-delta", delta: "x", extra: { kept: true } },
);
runEventValues.push(
  { type: "text-delat", delta: "x" },
  { type: "run-finish", runId: "", finishReason: "stp", usage: 3, steps: -1 },
  { type: "run-start", runId: 1, mode: "strem" },
);
const runEventSeen = new Set();
const runEventCases = runEventValues
  .filter((value) => {
    const key = JSON.stringify(value);
    return !runEventSeen.has(key) && runEventSeen.add(key);
  })
  .map((value) => ({ value, expect: validateRunEvent(clone(value)) }));

const runEventTypeCases = [
  ...runEvents.map((e) => e.type),
  "run-end",
  "resync",
  "done",
  "Run-Finish",
  "run-finish ",
  "request.completed",
  "",
].map((type) => ({ type, expect: { known: isRunEventType(type), terminal: isRunTerminalEvent({ type }) } }));

const ev = Object.fromEntries(runEvents.map((e) => [e.type, e]));
const wait = (callId) => ({ type: "awaiting-user", callId, card: { ...runCard, callId } });
const answer = (callId) => ({ type: "user-responded", callId, action: { ...runAction, callId } });
const result = (callId) => ({ type: "tool-result", callId, name: "search", output: null, ms: 1 });
const runStreams = [
  [],
  [null, 42, "run-finish", [], {}, { type: 7 }, { type: "resync" }, { type: "done" }],
  [ev["run-start"]],
  [ev["run-start"], ev["text-delta"]],
  [ev["run-start"], ev["text-delta"], ev["run-finish"]],
  [ev["run-finish"]],
  [ev["text-delta"]],
  [ev["run-start"], ev["error"]],
  [ev["run-start"], ev["error"], { ...ev["run-finish"], finishReason: "error" }],
  [ev["run-start"], { ...ev["run-finish"], finishReason: "cancelled" }],
  [ev["run-start"], ev["tool-call"], wait("call_1")],
  [ev["run-start"], ev["tool-call"], wait("call_1"), answer("call_1")],
  [ev["run-start"], ev["tool-call"], wait("call_1"), answer("call_1"), result("call_1"), ev["run-finish"]],
  [ev["run-start"], wait("call_1"), result("call_1")],
  [ev["run-start"], wait("call_1"), wait("call_2"), answer("call_1")],
  [ev["run-start"], wait("call_1"), wait("call_2"), answer("call_1"), answer("call_2")],
  [ev["run-start"], wait("call_1"), answer("call_2")],
  [ev["run-start"], wait("call_1"), wait("call_1"), answer("call_1")],
  [ev["run-start"], wait("call_1"), ev["run-finish"]],
  [ev["run-start"], wait("call_1"), ev["run-snapshot"]],
  [ev["run-start"], wait("call_1"), ev["run-snapshot"], wait("call_1")],
  [ev["run-start"], ev["run-finish"], ev["run-snapshot"]],
  [ev["run-start"], ev["run-finish"], ev["run-start"]],
  [ev["run-start"], ev["run-finish"], ev["run-start"], ev["text-delta"], ev["run-finish"]],
  [ev["run-start"], ev["run-finish"], wait("call_1")],
  [ev["run-start"], ev["run-finish"], ev["text-delta"]],
  [ev["run-snapshot"]],
  [ev["run-snapshot"], wait("call_1")],
  [ev["run-snapshot"], ev["text-delta"], ev["run-finish"]],
  [ev["run-start"], { type: "awaiting-user" }],
  [ev["run-start"], { type: "awaiting-user", callId: 7 }, { type: "user-responded" }],
  [ev["run-start"], wait("call_1"), { type: "resync" }, { type: "done" }],
  [{ type: "resync" }, ev["run-start"], ev["step-start"], ev["usage"], ev["step-finish"]],
  [ev["run-start"], ev["job-started"], ev["job-status"]],
  runEvents,
];
const runStreamCases = runStreams.map((events) => ({ events, expect: runStreamOutcome(clone(events)) }));

// ---- SSE parser ------------------------------------------------------------------------------
const enc = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
async function runSSE(chunks, maxFrameBytes) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  const frames = [];
  try {
    for await (const f of maxFrameBytes === undefined ? parseSSE(body) : parseSSE(body, maxFrameBytes)) frames.push(f);
  } catch (e) {
    return { frames, error: e.code ?? String(e) };
  }
  return { frames };
}
function split(bytes, parts) {
  const cuts = new Set();
  for (let i = 0; i < parts - 1; i++) cuts.add(rand(bytes.length + 1));
  const sorted = [...cuts].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const c of [...sorted, bytes.length]) {
    out.push(bytes.slice(prev, c));
    prev = c;
  }
  return out;
}
const sseTexts = [
  "event: output.delta\ndata: {\"text\":\"hi\"}\n\n",
  "data: one\n\ndata: two\n\n",
  "event: a\r\ndata: b\r\n\r\nevent: c\r\ndata: d\r\n\r\n",
  "data: line1\ndata: line2\ndata: line3\n\n",
  "event: x\n\n",
  "data:\n\n",
  "data: \n\n",
  "data:  two spaces\n\n",
  "data:nospace\n\n",
  "event:  padded  \ndata: v\n\n",
  "event: first\nevent: second\ndata: v\n\n",
  "data: only\n",
  "data: only\n\ndata: unterminated",
  ": comment\ndata: after comment\n\n",
  "id: 7\nretry: 100\ndata: ignored fields\n\n",
  "dataX: no\n\ndata: yes\n\n",
  "data\n\ndata: bare\n\n",
  "data: a\r\n\ndata: b\n\r\n",
  "data: lone\rcarriage\n\n",
  "\n\n\n\ndata: leading blanks\n\n",
  "data: é日本😀\n\n",
  "event: 事件\ndata: 😀😀😀\n\n",
  "data: x\n\n\n\ndata: y\n\n",
  "event: e\n\n\ndata: d\n\n",
  "data: a\n \ndata: b\n\n",
  "",
  "\n\n",
  "garbage without terminator",
];
for (let i = 0; i < 40; i++) {
  let t = "";
  for (let f = 0; f < 1 + rand(6); f++) {
    const eol = rand(3) === 0 ? "\r\n" : "\n";
    if (rand(2)) t += "event: " + pick(["output.delta", "request.started", "request.completed", "ping", "é"]) + eol;
    for (let l = 0; l < 1 + rand(3); l++)
      t += "data: " + pick(["{\"text\":\"a\"}", "x", "日本語", "😀 emoji", "", "  lead", "a:b"]) + eol;
    t += eol;
  }
  sseTexts.push(t);
}
const sseCases = [];
for (const text of sseTexts) {
  const bytes = enc.encode(text);
  for (const parts of [1, 2, 3, 7, bytes.length || 1]) {
    const chunks = split(bytes, parts);
    const maxFrameBytes = undefined;
    sseCases.push({ chunks: chunks.map(hex), expect: await runSSE(chunks, maxFrameBytes) });
  }
}
// frame size limits
for (const [text, limit] of [
  ["data: " + "x".repeat(100) + "\n\n", 50],
  ["data: " + "x".repeat(100) + "\n\n", 200],
  ["data: x\n\n", 8],
  ["data: x\n\n", 9],
  ["data: x\n\n", 10],
  ["data: x\n\ndata: y\n\n", 10],
  ["data: " + "x".repeat(30), 20],
  ["data: " + "😀".repeat(10) + "\n\n", 30],
  ["data: " + "😀".repeat(10) + "\n\n", 26],
  ["data: " + "😀".repeat(10) + "\n\n", 27],
  ["data: x\n\n".repeat(20), 10],
  ["data: " + "é".repeat(20) + "\n\n", 40],
]) {
  const bytes = enc.encode(text);
  for (const parts of [1, 4, bytes.length]) {
    const chunks = split(bytes, parts);
    sseCases.push({ chunks: chunks.map(hex), max_frame_bytes: limit, expect: await runSSE(chunks, limit) });
  }
}


// ---- card references -------------------------------------------------------------------------
const repeat = (c, n) => c.repeat(n);
const refHrefs = [
  "ref:btc",
  "ref:btc?key=support",
  "ref:btc?key=a&key=b",
  "ref:btc?key=a%2Cb",
  "ref:btc?key=a&other=b&key=c",
  "ref:sales?x=2026-03",
  "ref:sales?x=2026-03..2026-05&y=10..20&series=eu&series=us",
  "ref:a.b_c:d-e?k=1",
  "ref:A1",
  "ref:1a",
  "ref:btc?from=1767225600000&to=1767312000000",
  "ref:btc?from=1&to=2&low=1.5&high=2.5",
  "ref:btc?key=%E6%94%AF%E6%92%90",
  "ref:btc?key=%e6%94%af%e6%92%90",
  "ref:btc?key=%F0%9F%98%80",
  "ref:btc?key=a~b.c_d-e",
  "ref:btc?key=%20",
  "ref:btc?key=100%25",
  "ref:btc?constructor=1",
  "ref:btc?toString=1",
  "ref:btc?key=" + repeat("a", 256),
  "ref:btc?key=" + repeat("a", 257),
  "ref:" + repeat("t", 128),
  "ref:" + repeat("t", 129),
  "ref:" + repeat("t", 500),
  "ref:" + repeat("t", 509),
  "ref:" + repeat("t", 510),
  "ref:" + repeat("t", 128) + "?k=" + repeat("v", 256) + "&j=" + repeat("v", 100),
  "ref:t?" + Array.from({ length: 32 }, () => "k=v").join("&"),
  "ref:t?" + Array.from({ length: 33 }, () => "k=v").join("&"),
  "ref:t?" + Array.from({ length: 16 }, (_, i) => "p" + i + "=1").join("&"),
  "ref:t?" + Array.from({ length: 17 }, (_, i) => "p" + i + "=1").join("&"),
  "ref:t?" + repeat("k", 32) + "=1",
  "ref:t?" + repeat("k", 33) + "=1",
  "ref:",
  "ref:?k=v",
  "ref:btc?",
  "ref:btc?k",
  "ref:btc?k=",
  "ref:btc?=v",
  "ref:btc?k=v&",
  "ref:btc?&k=v",
  "ref:btc?k=v&&j=w",
  "ref:btc?K=v",
  "ref:btc?1=v",
  "ref:btc?k_1=v",
  "ref:btc?k-1=v",
  "ref:btc?k=a=b",
  "ref:btc?k=a b",
  "ref:btc?k=a+b",
  "ref:btc?k=a/b",
  "ref:btc?k=a?b",
  "ref:btc?k=a,b",
  "ref:btc?k=%",
  "ref:btc?k=%4",
  "ref:btc?k=%GG",
  "ref:btc?k=%C0%AF",
  "ref:btc?k=%C3",
  "ref:btc?k=%ED%A0%80",
  "ref:btc?k=%F4%90%80%80",
  "ref:btc?k=%EF%BB%BFx",
  "ref:btc?k=%00",
  "ref:btc#frag",
  "ref:btc?k=v#frag",
  "ref:bt c",
  "ref:-btc",
  ".btc",
  "ref:btc/x",
  "ref:btc@x",
  "REF:btc",
  "Ref:btc",
  "ref btc",
  "ref//btc",
  "refs:btc",
  "https://example.com",
  "javascript:alert(1)",
  "#ref:btc",
  " ref:btc",
  "ref:btc ",
  "",
  "ref",
  "ref:é",
];
const refParseCases = [...refHrefs, null, undefined, 5, {}, [], true].map((value) => ({ value: value === undefined ? { undefined: true } : value, expect: parseCardRef(value === undefined ? undefined : value) }));
const refFormatCases = [];
const addFormat = (value) => refFormatCases.push({ value, expect: formatCardRef(value) });
for (const href of refHrefs) {
  const parsed = parseCardRef(href);
  if (parsed.ok) addFormat(parsed.ref);
}
for (const value of [
  { target: "btc", params: {} },
  { target: "btc", params: { key: ["a"] } },
  { target: "btc", params: { b: ["2"], a: ["1"] } },
  { target: "btc", params: { key: ["a", "b"] } },
  { target: "btc", params: { key: ["a b"] } },
  { target: "btc", params: { key: ["a&b=c"] } },
  { target: "btc", params: { key: ["%"] } },
  { target: "btc", params: { key: ["~._-"] } },
  { target: "btc", params: { key: ["日本語"] } },
  { target: "btc", params: { key: ["😀"] } },
  { target: "btc", params: { key: ["a,b", "c"] } },
  { target: "btc", params: { key: ["!'()*"] } },
  { target: "btc", params: { key: [repeat("a", 256)] } },
  { target: "btc", params: { key: [repeat("a", 257)] } },
  { target: "btc", params: { key: [repeat("😀", 128)] } },
  { target: "btc", params: { key: [repeat("😀", 129)] } },
  { target: "btc", params: { key: [""] } },
  { target: "btc", params: { key: [] } },
  { target: "btc", params: { key: "a" } },
  { target: "btc", params: { key: [1] } },
  { target: "btc", params: { key: [null] } },
  { target: "btc", params: { Key: ["a"] } },
  { target: "btc", params: { "": ["a"] } },
  { target: "btc", params: { "1": ["a"] } },
  { target: "btc", params: { [repeat("k", 32)]: ["a"] } },
  { target: "btc", params: { [repeat("k", 33)]: ["a"] } },
  { target: "btc", params: Object.fromEntries(Array.from({ length: 16 }, (_, i) => ["p" + i, ["1"]])) },
  { target: "btc", params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ["p" + i, ["1"]])) },
  { target: "btc", params: { k: Array.from({ length: 32 }, () => "v") } },
  { target: "btc", params: { k: Array.from({ length: 33 }, () => "v") } },
  { target: "t".repeat(128), params: {} },
  { target: "t".repeat(129), params: {} },
  { target: "", params: {} },
  { target: "-t", params: {} },
  { target: "a b", params: {} },
  { target: "é", params: {} },
  { target: 5, params: {} },
  { target: "btc" },
  { target: "btc", params: null },
  { target: "btc", params: [] },
  { target: "btc", params: "x" },
  { target: "t".repeat(128), params: { a: [repeat("v", 256)], b: [repeat("v", 100)] } },
  { target: "t".repeat(100), params: { k: [repeat("😀", 20)] } },
  null,
  [],
  "ref:btc",
  5,
])
  addFormat(value);
const chartRefTargets = [
  "ref:btc",
  "ref:btc?key=support",
  "ref:btc?key=%E6%94%AF%E6%92%90",
  "ref:btc?key=a&key=b",
  "ref:btc?key=" + repeat("a", 128),
  "ref:btc?key=" + repeat("a", 129),
  "ref:btc?from=1&to=2",
  "ref:btc?from=2&to=1",
  "ref:btc?from=2&to=2",
  "ref:btc?from=1",
  "ref:btc?to=1",
  "ref:btc?from=-5&to=5",
  "ref:btc?from=0&to=0",
  "ref:btc?from=-0&to=0",
  "ref:btc?from=1.5&to=2.25",
  "ref:btc?from=1767225600000&to=1767312000000",
  "ref:btc?from=1&to=2&low=1.5&high=2.5",
  "ref:btc?from=1&to=2&low=3&high=2",
  "ref:btc?from=1&to=2&low=2&high=2",
  "ref:btc?from=1&to=2&low=1",
  "ref:btc?from=1&to=2&high=1",
  "ref:btc?low=1&high=2",
  "ref:btc?from=1&to=2&from=3",
  "ref:btc?from=a&to=2",
  "ref:btc?from=1e3&to=2e3",
  "ref:btc?from=1.&to=2",
  "ref:btc?from=.5&to=2",
  "ref:btc?from=%2B1&to=2",
  "ref:btc?from=0x10&to=32",
  "ref:btc?from=1&to=" + repeat("9", 400),
  "ref:btc?from=-" + repeat("9", 400) + "&to=1",
  "ref:btc?from=1&to=" + repeat("9", 20),
  "ref:btc?from=0.1&to=0.30000000000000004",
  "ref:btc?key=a&from=1&to=2",
  "ref:btc?key=a&low=1&high=2",
  "ref:btc?key=a&other=b",
  "ref:btc?other=b&from=1&to=2",
  "ref:btc?series=a&x=1",
  "ref:btc?low=x&high=2&from=1&to=2",
];
const chartRefCases = chartRefTargets.map((href) => {
  const parsed = parseCardRef(href);
  return { value: parsed.ok ? parsed.ref : null, href, expect: parsed.ok ? parseChartRef(parsed.ref) : null };
});

// ---- card placement -------------------------------------------------------------------------
const placementValues = ["inline", "panel", "document", "Inline", "side", "", null, 1, true, [], {}, " panel"];
const placementCases = [];
for (const value of placementValues)
  for (const interactive of [false, true, null])
    placementCases.push({
      value,
      interactive,
      expect: { valid: isCardPlacement(value), allowed: canPlaceCard(interactive === null ? undefined : { interactive }, value) },
    });

// ---- host theme ------------------------------------------------------------------------------
const themeRead = (value) => {
  const theme = readHostTheme(clone(value));
  return { theme, variables: theme === null ? null : themeVariables(theme) };
};
const allTokens = Object.fromEntries(THEME_TOKENS.map((t, i) => [t, i < 12 ? `#${String(i).padStart(2, "0")}${String(i).padStart(2, "0")}${String(i).padStart(2, "0")}` : t === "radius" ? "8px" : `"Font ${t}", system-ui, sans-serif`]));
const themeValues = [
  { mode: "light", tokens: allTokens },
  { mode: "dark", tokens: allTokens },
  { mode: "dark", tokens: {} },
  { mode: "light" },
  { mode: "light", tokens: null },
  { mode: "light", tokens: [] },
  { mode: "light", tokens: "x" },
  { mode: "light", tokens: 5 },
  { mode: "light", tokens: { text: "#111", surface: "#fff", unknown: "x", __proto__x: "y" } },
  { mode: "light", tokens: { "font-sans": "Inter, sans-serif", "font-mono": "ui-monospace, 'Fira Code', monospace", radius: "0.5rem" } },
  { mode: "light", tokens: { accent: "rgb(10 20 30 / 50%)", border: "color-mix(in srgb, red 20%, blue)", background: "var(--page-bg, #fff)" } },
  { mode: "light", tokens: { text: "#111", extra: { nested: true } }, extra: 1 },
];
for (const mode of ["Light", "DARK", "", " light", "auto", "system", null, 1, true, [], {}]) themeValues.push({ mode, tokens: { text: "#111" } });
themeValues.push({ tokens: { text: "#111" } }, null, [], "light", 5, true, {}, { mode: ["light"] });
const themeCandidates = [
  "#111",
  "  #111  ",
  "\t#fff\n",
  "",
  "   ",
  " ",
  "　x　",
  "x".repeat(256),
  "x".repeat(257),
  " ".repeat(10) + "x".repeat(246),
  "x".repeat(255) + " ",
  "😀".repeat(128),
  "😀".repeat(129),
  "a;b",
  "a}b",
  "a{b",
  "a<b",
  "a>b",
  "a\\b",
  "a/*b",
  "a*/b",
  "a/b",
  "a*b",
  "url(x)",
  "URL(x)",
  "Url (x)",
  "url \t(x)",
  "url (x)",
  "url (x)",
  "url　(x)",
  "url﻿(x)",
  "url\u0085(x)",
  "url᠎(x)",
  "url​(x)",
  "url(",
  "url",
  "ur l(x)",
  "curl(x)",
  "urlx(",
  "expression(1)",
  "EXPRESSION (1)",
  "expreſſion(1)",
  "expreSSion(1)",
  "uRl(x)",
  "urK(x)",
  "@import",
  "@IMPORT x",
  "@imports",
  "import",
  "@ import",
  "e-expression(1)",
  "calc(1px + 2px)",
  "linear-gradient(red, blue)",
  "'quoted'",
  "\"double\"",
  "a\nb",
  "日本語フォント",
  5,
  0,
  null,
  true,
  [],
  ["#111"],
  {},
];
for (const candidate of themeCandidates) themeValues.push({ mode: "light", tokens: { text: candidate, accent: "#abc" } });
for (const token of THEME_TOKENS) themeValues.push({ mode: "dark", tokens: { [token]: "  v  " } });
const hostThemeCases = themeValues.map((value) => ({ value, expect: themeRead(value) }));

// ---- tool authority --------------------------------------------------------------------------
const authorityTools = [
  { authority: "read" },
  { authority: "draft" },
  { authority: "act" },
  { authority: "read", confirm: true },
  { authority: "act", confirm: false, name: "x" },
  { authority: "Read" },
  { authority: "executor" },
  { authority: "" },
  { authority: " read" },
  { authority: null },
  { authority: 1 },
  { authority: true },
  { authority: ["read"] },
  { authority: {} },
  {},
  { name: "t" },
  null,
  "read",
  5,
  [],
  true,
];
const toolAuthorityCases = authorityTools.map((tool) => {
  const authority = pluginToolAuthority(clone(tool));
  return { tool, expect: { authority, presets: authority === null ? [] : PLUGIN_TOOL_PRESETS[authority] } };
});

// ---- chat plugin (the data part: a manifest, the card kinds and mounts and tools it has) ----------
const pluginManifest = {
  manifestVersion: 0,
  name: "@supersolutions/demo-chat-plugin",
  version: "1.0.0",
  license: "Apache-2.0",
  capabilities: [
    { id: "demo.card", surface: "card", cardKind: "demo.card" },
    { id: "demo.panel", surface: "panel", cardKind: "demo.workspace" },
    { id: "demo.tool", surface: "tool", toolName: "demo_tool" },
  ],
};
const chatPlugin = {
  manifest: pluginManifest,
  cardKinds: [{ kind: "demo.card" }, { kind: "demo.workspace" }],
  mounts: ["demo.card", "demo.workspace"],
  tools: [{ name: "demo_tool", authority: "read" }],
};
const withManifest = (fn) => mut(chatPlugin, (p) => fn(p.manifest));
const chatPlugins = [
  chatPlugin,
  mut(chatPlugin, (p) => delete p.tools),
  mut(chatPlugin, (p) => delete p.cardKinds),
  mut(chatPlugin, (p) => delete p.mounts),
  mut(chatPlugin, (p) => ((p.cardKinds = []), (p.mounts = []))),
  mut(chatPlugin, (p) => (p.cardKinds = [{ kind: "demo.card" }])),
  mut(chatPlugin, (p) => (p.mounts = ["demo.card"])),
  mut(chatPlugin, (p) => (p.mounts = ["demo.workspace"])),
  mut(chatPlugin, (p) => (p.mounts = [])),
  mut(chatPlugin, (p) => (p.cardKinds = [{ kind: "other" }])),
  mut(chatPlugin, (p) => (p.tools = [])),
  mut(chatPlugin, (p) => (p.tools = [{ name: "other" }])),
  withManifest((m) => (m.capabilities = [{ id: "demo.panel", surface: "panel" }])),
  withManifest((m) => (m.capabilities = [{ id: "demo.panel", surface: "panel", cardKind: "missing" }])),
  withManifest((m) => (m.capabilities = [{ id: "demo.canvas", surface: "canvas" }])),
  withManifest((m) => (m.capabilities = [{ id: "demo.a", surface: "panel", cardKind: "demo.workspace" }, { id: "demo.b", surface: "panel", cardKind: "demo.workspace" }, { id: "demo.c", surface: "panel", cardKind: "demo.card" }])),
  withManifest((m) => (m.manifestVersion = 1)),
  withManifest((m) => (m.capabilities = [])),
  mut(chatPlugin, (p) => (p.manifest = null)),
  mut(chatPlugin, (p) => delete p.manifest),
  { manifest: { ...pluginManifest, capabilities: [{ id: "bad", surface: "card" }] }, cardKinds: [], mounts: [] },
];
for (const authority of ["read", "draft", "act", "root", "Read", "", null, 1, true, [], {}])
  chatPlugins.push(mut(chatPlugin, (p) => (p.tools = [{ name: "demo_tool", authority }])));
for (const confirm of [true, false, "yes", 1, 0, null, [], {}])
  chatPlugins.push(mut(chatPlugin, (p) => (p.tools = [{ name: "demo_tool", authority: "act", confirm }])));
chatPlugins.push(
  mut(chatPlugin, (p) => (p.tools = [{ name: "demo_tool" }, { name: "second", authority: "nope", confirm: "x" }, { name: "third", authority: "draft" }])),
  mut(chatPlugin, (p) => (p.tools = [{ name: "demo_tool", confirm: "x" }])),
);
const chatPluginCases = chatPlugins.map((plugin) => {
  const real = {
    manifest: clone(plugin).manifest,
    cardKinds: plugin.cardKinds?.map(({ kind }) => ({ kind, summary: "", schema: {}, validate: () => ({ ok: true }) })),
    mounts: plugin.mounts && Object.fromEntries(plugin.mounts.map((kind) => [kind, () => ({ update() {}, destroy() {} })])),
    tools: plugin.tools?.map((t) => ({ ...clone(t), description: "", inputSchema: {}, run: async () => null })),
  };
  const issues = validateChatPlugin(real);
  return { plugin, expect: { issues, panel_kinds: validatePluginManifest(real.manifest).length === 0 ? panelCardKinds(real) : null } };
});

// ---- inference request, message and stream event ----------------------------------------------------
const aTool = { name: "search", description: "Search the web", input_schema: { type: "object", properties: { q: { type: "string" } } } };
const aCall = { id: "call_1", name: "search", arguments: '{"q":"x"}' };
const request = {
  service: "chat",
  service_version: 3,
  customer_id: "cust_1",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Find it." },
    { role: "assistant", content: "", tool_calls: [aCall] },
    { role: "tool", tool_call_id: "call_1", content: "found", is_error: false },
    { role: "user", content: [{ type: "text", text: "and this?" }, { type: "image", url: "https://example.com/a.png", detail: "low" }] },
  ],
  tools: [aTool],
  tool_choice: { name: "search" },
  max_output_tokens: 512,
  timeout_ms: 30000,
};
const oneMessage = (m) => ({ ...request, messages: [m], tools: undefined, tool_choice: undefined });
const messageValues = [
  { role: "system", content: "s" },
  { role: "system", content: "" },
  { role: "system", content: 5 },
  { role: "system" },
  { role: "system", content: ["x"] },
  { role: "user", content: "hi" },
  { role: "user", content: "" },
  { role: "user", content: null },
  { role: "user", content: {} },
  { role: "user" },
  { role: "user", content: [] },
  { role: "user", content: [null] },
  { role: "user", content: ["x"] },
  { role: "user", content: [{}] },
  { role: "user", content: [{ type: "audio" }] },
  { role: "user", content: [{ type: "text" }] },
  { role: "user", content: [{ type: "text", text: 5 }] },
  { role: "user", content: [{ type: "text", text: "" }] },
  { role: "user", content: [{ type: "image" }] },
  { role: "user", content: [{ type: "image", url: 5 }] },
  { role: "user", content: [{ type: "image", url: "" }] },
  { role: "user", content: [{ type: "image", url: "https://example.com/a.png" }] },
  { role: "user", content: [{ type: "image", url: "HTTPS://EXAMPLE.COM/a.png", detail: "auto" }] },
  { role: "user", content: [{ type: "image", url: "https://example.com/a.png", detail: "high" }] },
  { role: "user", content: [{ type: "image", url: "https://example.com/a.png", detail: "max" }] },
  { role: "user", content: [{ type: "image", url: "https://example.com/a.png", detail: 1 }] },
  { role: "user", content: [{ type: "image", url: "http://example.com/a.png" }] },
  { role: "user", content: [{ type: "image", url: "ftp://example.com/a.png" }] },
  { role: "user", content: [{ type: "image", url: "file:///etc/passwd" }] },
  { role: "user", content: [{ type: "image", url: "javascript:alert(1)" }] },
  { role: "user", content: [{ type: "image", url: "//example.com/a.png" }] },
  { role: "user", content: [{ type: "image", url: "example.com/a.png" }] },
  { role: "user", content: [{ type: "image", url: "https://" }] },
  { role: "user", content: [{ type: "image", url: "https://exa mple.com/a.png" }] },
  { role: "user", content: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }] },
  { role: "user", content: [{ type: "image", url: "data:image/jpeg;base64,/9j/4AAQ" }] },
  { role: "user", content: [{ type: "image", url: "data:image/gif;base64,R0lGODlh" }] },
  { role: "user", content: [{ type: "image", url: "data:image/webp;base64,UklGRg==" }] },
  { role: "user", content: [{ type: "image", url: "data:image/svg+xml;base64,PHN2Zz4=" }] },
  { role: "user", content: [{ type: "image", url: "data:image/png;base64," }] },
  { role: "user", content: [{ type: "image", url: "data:image/png;base64,@@@" }] },
  { role: "user", content: [{ type: "image", url: "data:image/png;base64,AAAA===" }] },
  { role: "user", content: [{ type: "image", url: "data:image/png;base64,AAAA\n" }] },
  { role: "user", content: [{ type: "image", url: "data:image/png,AAAA" }] },
  { role: "user", content: [{ type: "image", url: "DATA:image/png;base64,AAAA" }] },
  { role: "user", content: [{ type: "text", text: "a" }, { type: "bad" }, { type: "image", url: "x" }, null] },
  { role: "assistant", content: "ok" },
  { role: "assistant", content: "" },
  { role: "assistant" },
  { role: "assistant", content: null },
  { role: "assistant", content: 5 },
  { role: "assistant", tool_calls: [aCall] },
  { role: "assistant", content: "x", tool_calls: [aCall] },
  { role: "assistant", content: 5, tool_calls: [aCall] },
  { role: "assistant", content: null, tool_calls: [aCall] },
  { role: "assistant", tool_calls: [] },
  { role: "assistant", tool_calls: null },
  { role: "assistant", tool_calls: "x" },
  { role: "assistant", tool_calls: {} },
  { role: "assistant", tool_calls: [null] },
  { role: "assistant", tool_calls: [{}] },
  { role: "assistant", tool_calls: [{ id: "", name: "search", arguments: "{}" }] },
  { role: "assistant", tool_calls: [{ id: 1, name: "search", arguments: "{}" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "", arguments: "{}" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "a b", arguments: "{}" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "a.b", arguments: "{}" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "x".repeat(64), arguments: "{}" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "x".repeat(65), arguments: "{}" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "ok_name-1", arguments: "" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "search" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "search", arguments: {} }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "search", arguments: "not json" }] },
  { role: "assistant", tool_calls: [aCall, aCall] },
  { role: "assistant", tool_calls: [aCall, { ...aCall, id: "call_2" }] },
  { role: "assistant", tool_calls: [{ id: "c", name: "é", arguments: "{}" }] },
  { role: "tool", tool_call_id: "call_1", content: "r" },
  { role: "tool", tool_call_id: "call_1", content: "r", is_error: true },
  { role: "tool", tool_call_id: "call_1", content: "r", is_error: "no" },
  { role: "tool", tool_call_id: "call_1", content: "r", is_error: null },
  { role: "tool", tool_call_id: "call_1" },
  { role: "tool", tool_call_id: "call_1", content: 5 },
  { role: "tool", tool_call_id: "", content: "r" },
  { role: "tool", tool_call_id: 1, content: "r" },
  { role: "tool", content: "r" },
  { role: "tool" },
  { role: "function", content: "x" },
  { role: "developer", content: "x" },
  { role: "User", content: "x" },
  { role: "", content: "x" },
  { role: null, content: "x" },
  { role: 1, content: "x" },
  { content: "x" },
  {},
  null,
  [],
  "user",
  5,
  true,
];
const inferenceMessageCases = messageValues.map((value) => ({ value, expect: validateInferenceMessage(clone(value)) }));
const requests = [
  request,
  { ...request, tools: undefined, tool_choice: undefined },
  mut(request, (r) => delete r.service_version),
  mut(request, (r) => delete r.max_output_tokens),
  mut(request, (r) => delete r.timeout_ms),
  mut(request, (r) => delete r.tool_choice),
  mut(request, (r) => (r.tools = [])),
  { service: "s", customer_id: "c", messages: [{ role: "user", content: "x" }] },
  ...messageValues.map(oneMessage),
  // a tool result must answer a call an earlier assistant message made
  { ...request, messages: [{ role: "tool", tool_call_id: "call_1", content: "r" }, { role: "assistant", tool_calls: [aCall] }] },
  { ...request, messages: [{ role: "assistant", tool_calls: [aCall] }, { role: "tool", tool_call_id: "call_2", content: "r" }] },
  { ...request, messages: [{ role: "assistant", tool_calls: [aCall, { ...aCall, id: "call_2" }] }, { role: "tool", tool_call_id: "call_2", content: "r" }, { role: "tool", tool_call_id: "call_1", content: "r" }] },
  { ...request, messages: [{ role: "assistant", tool_calls: [aCall] }, { role: "tool", tool_call_id: "call_1", content: "r" }, { role: "tool", tool_call_id: "call_1", content: "again" }] },
  { ...request, messages: [{ role: "assistant", tool_calls: [{ ...aCall, id: "" }] }, { role: "tool", tool_call_id: "", content: "r" }] },
  { ...request, messages: [{ role: "assistant", tool_calls: [aCall, aCall] }, { role: "tool", tool_call_id: "call_1", content: "r" }] },
];
for (const service of [undefined, null, "", 5, [], {}, "x"]) requests.push(mut(request, (r) => (service === undefined ? delete r.service : (r.service = service))));
for (const v of [undefined, null, -1, 0, 1, 1.5, "1", true, []]) requests.push(mut(request, (r) => (v === undefined ? delete r.service_version : (r.service_version = v))));
for (const v of [undefined, null, "", 5, {}]) requests.push(mut(request, (r) => (v === undefined ? delete r.customer_id : (r.customer_id = v))));
for (const v of [undefined, null, [], "x", {}, [null], [1], ["x"], [{}]]) requests.push(mut(request, (r) => (v === undefined ? delete r.messages : (r.messages = v))));
for (const tools of [
  null,
  "x",
  {},
  [null],
  ["x"],
  [{}],
  [{ name: "a" }],
  [{ name: "a", input_schema: {} }],
  [{ name: "a", input_schema: { type: "string" } }],
  [{ name: "a", input_schema: { type: "object" } }],
  [{ name: "a", input_schema: { type: ["object"] } }],
  [{ name: "a", input_schema: [] }],
  [{ name: "a", input_schema: null }],
  [{ name: "", input_schema: { type: "object" } }],
  [{ name: "a b", input_schema: { type: "object" } }],
  [{ name: "x".repeat(64), input_schema: { type: "object" } }],
  [{ name: "x".repeat(65), input_schema: { type: "object" } }],
  [{ name: 5, input_schema: { type: "object" } }],
  [{ name: "a", description: 5, input_schema: { type: "object" } }],
  [{ name: "a", description: "", input_schema: { type: "object" } }],
  [aTool, aTool],
  [aTool, { ...aTool, name: "other" }],
  [{ name: "a", input_schema: { type: "object" } }, { name: "a", input_schema: { type: "object" } }, { name: "a b" }],
]) requests.push(mut(request, (r) => (r.tools = tools)));
for (const choice of ["auto", "none", "required", "Auto", "", "any", null, 5, true, [], {}, { name: "search" }, { name: "" }, { name: 5 }, { name: "a b" }, { name: "search", extra: 1 }, ["auto"]])
  requests.push(mut(request, (r) => (r.tool_choice = choice)));
for (const v of [0, 1, 512, -1, 1.5, "512", null, true, [], {}]) {
  requests.push(mut(request, (r) => (r.max_output_tokens = v)));
  requests.push(mut(request, (r) => (r.timeout_ms = v)));
}
requests.push(null, [], "x", 5, true, {}, { messages: [] }, { service: "s", customer_id: "c", messages: "x", tools: 5, tool_choice: 7, max_output_tokens: 0, timeout_ms: 0 });
requests.push(
  { ...request, tool_choice: "requird" },
  { ...request, tool_choice: 3 },
  { service: 1, customer_id: "", messages: [], tools: [null, { name: "bad name", input_schema: { type: "string" } }], max_output_tokens: 0 },
);
const inferenceRequestCases = requests.map((value) => ({ value: clone(value), expect: validateInferenceRequest(clone(value)) }));

const meters = { input: 10, cached: 4, cache_write: 2, output: 7 };
const sUsage = { status: "confirmed", meters: { ...meters, images: 1, video_ms: 1500, audio_ms: 0, tasks: 2 } };
const streamEvents = [
  { type: "request.started", request_id: "req_1", sequence: 0, service_version: 3 },
  { type: "output.delta", request_id: "req_1", sequence: 1, text: "Hel" },
  { type: "output.tool_call.delta", request_id: "req_1", sequence: 2, index: 0, id: "call_1", name: "search", arguments_delta: '{"q"' },
  { type: "output.tool_call.completed", request_id: "req_1", sequence: 3, index: 0, id: "call_1", name: "search", arguments: '{"q":"x"}' },
  { type: "request.completed", request_id: "req_1", sequence: 4, execution_status: "succeeded", billing_status: "billed", finish_reason: "tool_calls", usage: sUsage },
  { type: "request.failed", request_id: "req_1", sequence: 5, execution_status: "failed", billing_status: "released", error: { code: "upstream_unavailable" }, usage: { status: "none" } },
  { type: "request.replayed", request_id: "req_1", sequence: 6 },
];
const streamValues = [...streamEvents];
const streamOptional = {
  "output.tool_call.delta": ["id", "name"],
  "request.completed": ["finish_reason", "usage"],
  "request.failed": ["execution_status", "billing_status", "error", "usage"],
};
for (const base of streamEvents) {
  if (streamOptional[base.type]) streamValues.push(mut(base, (e) => streamOptional[base.type].forEach((k) => delete e[k])));
  for (const path of runPaths(base).filter((p) => p.length > 0 && p.join(".") !== "type")) {
    const key = path[path.length - 1];
    if (typeof key === "string") streamValues.push(mut(base, (e) => delete runAt(e, path)[key]));
    for (const junk of runJunk) streamValues.push(mut(base, (e) => (runAt(e, path)[key] = junk)));
  }
}
for (const status of ["succeeded", "failed", "cancelled", "unknown", "ok", "Succeeded", ""]) streamValues.push({ type: "request.completed", request_id: "r", sequence: 1, execution_status: status, billing_status: "b" });
for (const reason of ["stop", "length", "tool_calls", "tool-calls", "content_filter", "", null]) streamValues.push({ type: "request.completed", request_id: "r", sequence: 1, execution_status: "succeeded", billing_status: "b", finish_reason: reason });
for (const name of ["x".repeat(64), "x".repeat(65), "a b", ""]) streamValues.push({ type: "output.tool_call.delta", request_id: "r", sequence: 1, index: 0, name, arguments_delta: "" });
streamValues.push(
  { type: "output.delta", request_id: "r", sequence: 1, text: "" },
  { type: "output.tool_call.delta", request_id: "r", sequence: 1, index: 1, arguments_delta: "}" },
  { type: "request.completed", request_id: "r", sequence: 1, execution_status: "succeeded", billing_status: "b", usage: { status: "pending" } },
  { type: "request.completed", request_id: "r", sequence: 1, execution_status: "succeeded", billing_status: "b", usage: { status: "confirmed", meters: { input: 1 } } },
  { type: "request.completed", request_id: "r", sequence: 1, execution_status: "succeeded", billing_status: "b", usage: { status: "confirmed", meters: { ...meters, images: -1, tasks: 1.5 } } },
  { type: "request.completed", request_id: "r", sequence: 1, execution_status: "succeeded", billing_status: "b", usage: { status: "confirmed", meters: { ...meters, extra: "ignored" } } },
  { type: "request.replayed", request_id: "r", sequence: 0, extra: { kept: true } },
  { type: "request.started", request_id: "r", sequence: 0 },
  null,
  [],
  "request.started",
  5,
  true,
  {},
  { type: null },
  { type: 7 },
  { type: "" },
  { type: "request.Completed", request_id: "r", sequence: 0 },
  { type: "request.cancelled", request_id: "r", sequence: 0 },
  { type: "output.tool_call.started", request_id: "r", sequence: 0 },
  { type: "run-start", runId: "r", mode: "stream" },
  { request_id: "r", sequence: 0 },
);
streamValues.push(
  { type: "output.delat", request_id: "r", sequence: 0 },
  { type: "request.completed", request_id: "", sequence: -1, execution_status: "succeded", billing_status: 3, finish_reason: "stp", usage: 5 },
);
const streamSeen = new Set();
const streamEventCases = streamValues
  .filter((value) => {
    const key = JSON.stringify(value);
    return !streamSeen.has(key) && streamSeen.add(key);
  })
  .map((value) => ({ value, expect: validateStreamEvent(clone(value)) }));
const sev = Object.fromEntries(streamEvents.map((e) => [e.type, e]));
const inferenceStreams = [
  [],
  [null, 5, "request.completed", [], {}, { type: 7 }, { type: "resync" }],
  [sev["request.started"]],
  [sev["request.started"], sev["output.delta"]],
  [sev["request.started"], sev["output.delta"], sev["request.completed"]],
  [sev["request.started"], sev["output.delta"], sev["request.failed"]],
  [sev["request.replayed"]],
  [sev["request.completed"]],
  [sev["request.failed"]],
  [sev["request.started"], sev["output.tool_call.delta"], sev["output.tool_call.completed"]],
  [sev["request.started"], sev["output.tool_call.delta"], sev["output.tool_call.completed"], sev["request.completed"]],
  [sev["request.started"], sev["request.failed"], sev["request.completed"]],
  [sev["request.started"], sev["request.completed"], sev["request.failed"]],
  [sev["request.completed"], sev["request.replayed"]],
  [{ type: "resync" }, sev["request.started"], { type: "ping" }],
  [{ type: "resync" }, sev["request.started"], { type: "ping" }, sev["request.completed"]],
  [{ type: "request.completed" }],
  [{ type: "request.Completed" }, { type: 7 }],
  streamEvents.slice(0, 4),
  streamEvents,
];
const inferenceStreamCases = inferenceStreams.map((events) => ({ events, expect: inferenceStreamOutcome(clone(events)) }));

// ---- did you mean ----------------------------------------------------------------------------
// The hint of an `enum` issue: the closest allowed value within two edits (counted in code points), or none.
const modes = ["stream", "sync", "background"];
const didYouMeanCases = [
  ["strem", modes],
  ["stream", modes],
  ["Stream", modes],
  ["snyc", modes],
  ["sync ", modes],
  ["batch", modes],
  ["", ["a", "ab"]],
  ["", ["abc"]],
  ["ab", ["ac", "ad"]],
  ["ad", ["ac", "ab"]],
  ["abc", ["abd", "abe"]],
  ["abcd", ["ab"]],
  ["abcde", ["ab"]],
  ["日本語", ["日本"]],
  ["日本語", ["日本酒"]],
  ["😀😀", ["😀"]],
  ["😀x", ["x😀"]],
  ["é", ["e"]],
  ["Run-Finish", ["run-finish"]],
  ["tool_call", ["tool-call", "tool_calls"]],
  ["x", []],
  ["a", ["b", "c"]],
  ["a", ["bc", "a b"]],
  [7, modes],
  [null, modes],
  [[], modes],
  [{}, modes],
  [true, ["true"]],
].map(([value, allowed]) => ({ value, allowed, expect: didYouMean(value, allowed) ?? null }));

const out = {
  version: 1,
  note: "Generated by scripts/export-conformance.mjs from the TypeScript reference in implementations/typescript/. Every issue is {path, code, message} and, when there is something to add, hint (left out when there is none); issue_codes is the closed set of codes and did_you_mean the hint of an enum issue (null when nothing is close). Manifest validators return their issue lists as is; card validators (editor, chart, plot) return {ok, error, expected?, issues} where error is the first issue message and expected its hint when the code is required or exclusive; sse chunks are hex-encoded bytes. run_event holds issue lists, run_event_type whether a type is known and whether it ends a run, run_stream_outcome what a stopped stream says about its run. plot_fallback_message is the text a user sees in place of a plot that cannot be drawn. card_placement says whether a value is a placement and whether a kind (interactive true or false, null for no definition) may be shown there. host_theme: what readHostTheme keeps and the CSS variables themeVariables makes of it. tool_authority: the declared authority of a tool and the presets that grant it. chat_plugin: validateChatPlugin on the data of a plugin (its manifest, the card kinds it defines, the kinds it has a mount for, its tools) and the card kinds its manifest declares for the side panel. inference_message, inference_request and stream_event are issue lists; inference_stream_outcome is what a stopped gateway stream says about its request.",
  issue_codes: { codes: [...ISSUE_CODES] },
  did_you_mean: didYouMeanCases,
  plugin_manifest: manifestCases,
  editor_card: editorCases,
  chart_card: chartCases,
  plot_card: plotCases,
  card_ref_parse: refParseCases,
  card_ref_format: refFormatCases,
  chart_ref: chartRefCases,
  terminal_event: terminalCases,
  run_event: runEventCases,
  run_event_type: runEventTypeCases,
  run_stream_outcome: runStreamCases,
  card_placement: placementCases,
  host_theme: hostThemeCases,
  tool_authority: toolAuthorityCases,
  chat_plugin: chatPluginCases,
  inference_message: inferenceMessageCases,
  inference_request: inferenceRequestCases,
  stream_event: streamEventCases,
  inference_stream_outcome: inferenceStreamCases,
  sse: sseCases,
};
const lines = (key) => out[key].map((c) => "  " + JSON.stringify(c)).join(",\n");
const body =
  `{\n "version": 1,\n "note": ${JSON.stringify(out.note)},\n` +
  ` "plot_fallback_message": ${JSON.stringify(PLOT_FALLBACK_MESSAGE)},\n` +
  ` "issue_codes": ${JSON.stringify(out.issue_codes)},\n` +
  ["did_you_mean", "plugin_manifest", "editor_card", "chart_card", "plot_card", "card_ref_parse", "card_ref_format", "chart_ref", "terminal_event", "run_event", "run_event_type", "run_stream_outcome", "card_placement", "host_theme", "tool_authority", "chat_plugin", "inference_message", "inference_request", "stream_event", "inference_stream_outcome", "sse"]
    .map((k) => ` "${k}": [\n${lines(k)}\n ]`)
    .join(",\n") +
  "\n}\n";
writeFileSync(new URL("../conformance/protocol.v1.json", import.meta.url), body);
const ok = (cases) => cases.filter((c) => (Array.isArray(c.expect) ? c.expect.length === 0 : c.expect?.ok === true)).length;
console.log(
  `manifest ${manifestCases.length} (${ok(manifestCases)} valid), editor ${editorCases.length} (${ok(editorCases)} valid), chart ${chartCases.length} (${ok(chartCases)} valid), plot ${plotCases.length} (${ok(plotCases)} valid), ref parse ${refParseCases.length} (${refParseCases.filter((c) => c.expect.ok).length} valid), ref format ${refFormatCases.length} (${refFormatCases.filter((c) => c.expect !== null).length} valid), chart ref ${chartRefCases.length} (${chartRefCases.filter((c) => c.expect?.ok).length} valid), terminal ${terminalCases.length}, run event ${runEventCases.length} (${ok(runEventCases)} valid), run event type ${runEventTypeCases.length}, run stream ${runStreamCases.length}, placement ${placementCases.length}, host theme ${hostThemeCases.length}, tool authority ${toolAuthorityCases.length}, chat plugin ${chatPluginCases.length} (${chatPluginCases.filter((c) => c.expect.issues.length === 0).length} valid), inference message ${inferenceMessageCases.length} (${ok(inferenceMessageCases)} valid), inference request ${inferenceRequestCases.length} (${ok(inferenceRequestCases)} valid), stream event ${streamEventCases.length} (${ok(streamEventCases)} valid), inference stream ${inferenceStreamCases.length}, sse ${sseCases.length} (${sseCases.filter((c) => c.expect.error).length} errors)`,
);
