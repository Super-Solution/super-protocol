// Writes conformance/protocol.v1.json: language-neutral cases generated from the TypeScript
// reference in implementations/typescript/ (plugin manifest, editor, chart and plot card specs, SSE parser,
// terminal-event check). Go and Python must reproduce every case exactly.
//
// Run `pnpm build` first: the generator imports the built
// package. implementations/typescript/src/conformance.test.ts fails if the file drifts from the reference.
import { writeFileSync } from "node:fs";
import {
  formatCardRef,
  isTerminalEvent,
  parseCardRef,
  parseChartRef,
  parseSSE,
  validateChartCardSpec,
  validateEditorCardSpec,
  validatePlotCardSpec,
  validatePluginManifest,
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

const out = {
  version: 1,
  note: "Generated by scripts/export-conformance.mjs from the TypeScript reference in implementations/typescript/. Manifest and card validators (editor, chart, plot) return their issue lists or result objects as is; sse chunks are hex-encoded bytes. plot_fallback_message is the text a user sees in place of a plot that cannot be drawn.",
  plugin_manifest: manifestCases,
  editor_card: editorCases,
  chart_card: chartCases,
  plot_card: plotCases,
  card_ref_parse: refParseCases,
  card_ref_format: refFormatCases,
  chart_ref: chartRefCases,
  terminal_event: terminalCases,
  sse: sseCases,
};
const lines = (key) => out[key].map((c) => "  " + JSON.stringify(c)).join(",\n");
const body =
  `{\n "version": 1,\n "note": ${JSON.stringify(out.note)},\n` +
  ` "plot_fallback_message": ${JSON.stringify(PLOT_FALLBACK_MESSAGE)},\n` +
  ["plugin_manifest", "editor_card", "chart_card", "plot_card", "card_ref_parse", "card_ref_format", "chart_ref", "terminal_event", "sse"]
    .map((k) => ` "${k}": [\n${lines(k)}\n ]`)
    .join(",\n") +
  "\n}\n";
writeFileSync(new URL("../conformance/protocol.v1.json", import.meta.url), body);
const ok = (cases) => cases.filter((c) => (Array.isArray(c.expect) ? c.expect.length === 0 : c.expect?.ok === true)).length;
console.log(
  `manifest ${manifestCases.length} (${ok(manifestCases)} valid), editor ${editorCases.length} (${ok(editorCases)} valid), chart ${chartCases.length} (${ok(chartCases)} valid), plot ${plotCases.length} (${ok(plotCases)} valid), ref parse ${refParseCases.length} (${refParseCases.filter((c) => c.expect.ok).length} valid), ref format ${refFormatCases.length} (${refFormatCases.filter((c) => c.expect !== null).length} valid), chart ref ${chartRefCases.length} (${chartRefCases.filter((c) => c.expect?.ok).length} valid), terminal ${terminalCases.length}, sse ${sseCases.length} (${sseCases.filter((c) => c.expect.error).length} errors)`,
);
