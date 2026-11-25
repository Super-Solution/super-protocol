/**
 * How a financial chart travels through chat: the market-data contracts, the
 * annotation spec, the card kind and its validator. The chart package (any
 * license) implements the renderer and the feed adapters; hosts and agents only
 * need this file to produce and route the card.
 *
 * The data contracts are the neutral subset every chart backend needs. They are
 * structurally identical to the types of `@supersolutions/super-chart-core`, so
 * a datafeed written against either is accepted by the other.
 */
import { cardResult, type CardKindDefinition, type CardValidationResult } from "./chat.js";
import { filled, finite, finiteBetween, isObject, oneOf, short, str, wrongType, type Fields } from "./check.js";
import { collector, jsonType, type Add } from "./issue.js";

export const CHART_CARD_KIND = "super-chart.chart";

/** One OHLCV bar. `timestamp` is the bar open time in milliseconds. */
export interface MarketBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  turnover?: number;
  [key: string]: unknown;
}

export type Timespan = "second" | "minute" | "hour" | "day" | "week" | "month" | "year" | (string & {});

export interface SymbolInfo {
  ticker: string;
  name?: string;
  shortName?: string;
  exchange?: string;
  market?: string;
  /** Decimals on the price axis; "auto" derives it from the loaded prices. */
  pricePrecision?: number | "auto";
  volumePrecision?: number;
  priceCurrency?: string;
  type?: string;
  logo?: string;
  /** IANA zone in which this symbol's daily and longer bars open. Default UTC. */
  timezone?: string;
}

export interface Period {
  multiplier: number;
  timespan: Timespan;
  /** Label shown to the user, for example "1h" or "1D". */
  text: string;
}

export interface HistoryRequest {
  /** Aborted when the answer is no longer wanted. */
  signal: AbortSignal;
  /** True for the first request of a series, false for scroll-back and catch-up. */
  firstDataRequest: boolean;
  /** How many bars the chart wants (a size hint). */
  countBack: number;
  /** Scroll-back only: answer with bars strictly older than this timestamp. */
  before?: number;
}

export interface HistoryResult {
  bars: MarketBar[];
  /** True: nothing exists before these bars. */
  noData?: boolean;
}

export interface SearchRequest {
  signal: AbortSignal;
}

export type DatafeedSubscribeCallback = (data: MarketBar | MarketBar[]) => void;

/** A market-data source. Bars are `from <= timestamp < to`, oldest first. */
export interface Datafeed {
  searchSymbols(search?: string, request?: SearchRequest): Promise<SymbolInfo[]>;
  getHistoryKLineData(symbol: SymbolInfo, period: Period, from: number, to: number, request?: HistoryRequest): Promise<MarketBar[] | HistoryResult>;
  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void;
  unsubscribe(symbol: SymbolInfo, period: Period): void;
  resolvePeriod?(period: Pick<Period, "multiplier" | "timespan">): Period | null;
}

export type ChartAnnotationKind = "level" | "zone" | "marker" | "trend" | "ray" | "fibonacci" | "plan";

/** How many anchors each kind takes. `level`, `zone` and `marker` are the basic marks; the rest are drawn by the chart's templates. */
export const CHART_ANNOTATION_ANCHORS: Readonly<Record<ChartAnnotationKind, number>> = Object.freeze({ level: 1, zone: 2, marker: 1, trend: 2, ray: 2, fibonacci: 2, plan: 3 });
export const CHART_ANNOTATION_KINDS = Object.keys(CHART_ANNOTATION_ANCHORS) as ChartAnnotationKind[];
export type ChartAnnotationTone = "bull" | "bear" | "neutral" | "accent";

/**
 * A mark an agent or a person places on the chart. `level` is a horizontal
 * price line (one anchor, price required); `zone` is a price band over a time
 * range (two anchors, prices required); `marker` is a point label (one anchor).
 * `trend` is a line through two points and `ray` the same line extended to the
 * right; `fibonacci` is retracement levels between two points; `plan` is a
 * trade plan with entry, target and stop (three anchors, in that order). Each of
 * those anchors needs a price. Time is milliseconds since the epoch, like bars.
 */
export interface ChartAnnotation {
  key: string;
  kind: ChartAnnotationKind;
  anchors: Array<{ time: number; price?: number }>;
  text?: string;
  tone?: ChartAnnotationTone;
  /** CSS color; overrides the tone. */
  color?: string;
  /** Options for `trend`, `ray`, `fibonacci` and `plan`, for example `{ extend: "right" }`. Scalar values only. */
  params?: Record<string, number | string | boolean>;
}

export interface ChartIndicator {
  /** A registered indicator name, for example "MA", "RSI", "MACD". */
  name: string;
  params?: number[];
}

export const CHART_TYPES = ["candles", "hollow-candles", "ohlc", "line", "area", "baseline", "heikin-ashi"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartCardSpec {
  kind: typeof CHART_CARD_KIND;
  /** Stable id so a later tool call can address this chart. */
  id?: string;
  title?: string;
  symbol: SymbolInfo;
  period: Period;
  /** Height in CSS pixels. Default 420. */
  height?: number;
  chartType?: ChartType;
  /** Inline snapshot of bars (oldest first). Exactly one of `bars` or `feed`. */
  bars?: MarketBar[];
  /** A datafeed the host registered under this id. */
  feed?: { id: string };
  indicators?: ChartIndicator[];
  annotations?: ChartAnnotation[];
}

export const CHART_LIMITS = Object.freeze({ bars: 20000, annotations: 256, indicators: 12, anchors: 3, textLength: 2048, keyLength: 128, params: 16, paramKeyLength: 32, paramStringLength: 128, height: [160, 1200] as const });

const ANNOTATION_TONES = ["bull", "bear", "neutral", "accent"] as const;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** The first message of what `fill` finds, or null: the shape of the exported helpers below. */
function firstMessage(fill: (add: Add) => void): string | null {
  const { issues, add } = collector();
  fill(add);
  return issues[0]?.message ?? null;
}

function period(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "period must be an object.");
  const multiplier = "period.multiplier must be a positive integer.";
  if (typeof v.multiplier !== "number") wrongType(add, `${path}.multiplier`, v.multiplier, multiplier);
  else if (!Number.isSafeInteger(v.multiplier) || v.multiplier <= 0) add(`${path}.multiplier`, "range", multiplier);
  filled(add, `${path}.timespan`, v.timespan, "period.timespan must be a non-empty string.");
  filled(add, `${path}.text`, v.text, "period.text must be a non-empty string.");
}

function symbol(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "symbol must be an object.");
  filled(add, `${path}.ticker`, v.ticker, "symbol.ticker must be a non-empty string.");
  for (const k of ["name", "shortName", "exchange", "market", "priceCurrency", "type", "logo", "timezone"] as const) {
    if (v[k] !== undefined) str(add, `${path}.${k}`, v[k], `symbol.${k} must be a string.`);
  }
  const precision = v.pricePrecision;
  if (precision !== undefined && precision !== "auto") {
    const message = 'symbol.pricePrecision must be an integer from 0 to 12 or "auto".';
    if (typeof precision !== "number") add(`${path}.pricePrecision`, "type", message, `got ${jsonType(precision)}`);
    else if (!(Number.isInteger(precision) && precision >= 0 && precision <= 12)) add(`${path}.pricePrecision`, "range", message);
  }
}

function bar(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) return wrongType(add, path, v, "a bar must be an object.");
  for (const k of ["timestamp", "open", "high", "low", "close"] as const) finite(add, `${path}.${k}`, v[k], `bar.${k} must be a finite number.`);
  if (v.volume !== undefined) finite(add, `${path}.volume`, v.volume, "bar.volume must be a finite number.");
  const { open, high, low, close } = v;
  if ([open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n))) {
    const [o, h, l, c] = [open, high, low, close] as number[];
    if (h! < Math.max(o!, c!, l!) || l! > Math.min(o!, c!)) add(path, "shape", "bar high/low must contain open and close.");
  }
}

/** Checks one annotation; returns its key when the key is a usable one, so the caller can look for duplicates. */
function annotation(add: Add, path: string, v: unknown): string | undefined {
  if (!isObject(v)) return void wrongType(add, path, v, "an annotation must be an object.");
  const keyMessage = `annotation.key must be a non-empty string of at most ${CHART_LIMITS.keyLength} characters.`;
  filled(add, `${path}.key`, v.key, keyMessage);
  const key = typeof v.key === "string" && v.key.trim() !== "" ? v.key : undefined;
  if (key !== undefined && key.length > CHART_LIMITS.keyLength) add(`${path}.key`, "length", keyMessage);
  oneOf(add, `${path}.kind`, v.kind, CHART_ANNOTATION_KINDS, 'annotation.kind must be "level", "zone", "marker", "trend", "ray", "fibonacci" or "plan".');
  const kind = CHART_ANNOTATION_KINDS.includes(v.kind as ChartAnnotationKind) ? (v.kind as ChartAnnotationKind) : undefined;
  const anchorsMessage = "annotation.anchors must hold one to three anchors.";
  if (!Array.isArray(v.anchors)) wrongType(add, `${path}.anchors`, v.anchors, anchorsMessage);
  else if (v.anchors.length === 0) add(`${path}.anchors`, "empty", anchorsMessage);
  else if (v.anchors.length > CHART_LIMITS.anchors) add(`${path}.anchors`, "limit", anchorsMessage);
  let anchorsOk = false;
  if (Array.isArray(v.anchors) && v.anchors.length >= 1 && v.anchors.length <= CHART_LIMITS.anchors) {
    anchorsOk = true;
    v.anchors.forEach((a: unknown, j) => {
      const ap = `${path}.anchors[${j}]`;
      if (!isObject(a)) {
        anchorsOk = false;
        return wrongType(add, ap, a, "annotation anchors need a finite time.");
      }
      finite(add, `${ap}.time`, a.time, "annotation anchors need a finite time.");
      if (a.price !== undefined) finite(add, `${ap}.price`, a.price, "annotation anchor price must be a finite number.");
    });
  }
  if (kind !== undefined && anchorsOk) {
    const anchors = v.anchors as Array<Fields>;
    const needed = CHART_ANNOTATION_ANCHORS[kind];
    const priced = (a: Fields) => a.price !== undefined;
    let problem: string | undefined;
    if (kind === "level") {
      if (anchors.length !== 1 || !priced(anchors[0]!)) problem = "a level needs exactly one anchor with a price.";
    } else if (kind === "zone") {
      if (anchors.length !== 2 || !anchors.every(priced)) problem = "a zone needs two anchors, both with a price.";
    } else if (kind === "marker") {
      if (anchors.length !== 1) problem = "a marker needs exactly one anchor.";
    } else if (anchors.length !== needed || !anchors.every(priced)) problem = `a ${kind} needs ${needed} anchors, all with a price.`;
    if (problem !== undefined) add(`${path}.anchors`, "shape", problem);
  }
  if (v.params !== undefined) {
    const pp = `${path}.params`;
    if (kind === "level" || kind === "zone" || kind === "marker") add(pp, "shape", "annotation.params applies only to trend, ray, fibonacci and plan.");
    else if (!isObject(v.params)) wrongType(add, pp, v.params, "annotation.params must be an object.");
    else {
      const entries = Object.entries(v.params);
      if (entries.length > CHART_LIMITS.params) add(pp, "limit", `annotation.params may hold at most ${CHART_LIMITS.params} entries.`);
      for (const [name, value] of entries) {
        if (!PARAM_KEY.test(name)) add(`${pp}.${name}`, "format", "annotation.params keys must be 1 to 32 letters, digits, dash or underscore, starting with a letter.");
        const message = `annotation.params.${name} must be a finite number, a boolean or a string of at most ${CHART_LIMITS.paramStringLength} characters.`;
        if (typeof value === "number") {
          if (!Number.isFinite(value)) add(`${pp}.${name}`, "range", message);
        } else if (typeof value === "string") {
          if (value.length > CHART_LIMITS.paramStringLength) add(`${pp}.${name}`, "length", message);
        } else if (typeof value !== "boolean") add(`${pp}.${name}`, "type", message, `got ${jsonType(value)}`);
      }
    }
  }
  if (v.text !== undefined) short(add, `${path}.text`, v.text, CHART_LIMITS.textLength, `annotation.text must be a string of at most ${CHART_LIMITS.textLength} characters.`);
  if (v.tone !== undefined) oneOf(add, `${path}.tone`, v.tone, ANNOTATION_TONES, "annotation.tone must be bull, bear, neutral or accent.");
  if (v.color !== undefined) short(add, `${path}.color`, v.color, 128, "annotation.color must be a short CSS color string.");
  return key !== undefined && key.length <= CHART_LIMITS.keyLength ? key : undefined;
}

function annotations(add: Add, path: string, v: unknown): void {
  if (!Array.isArray(v)) return wrongType(add, path, v, "annotations must be an array.");
  if (v.length > CHART_LIMITS.annotations) add(path, "limit", `at most ${CHART_LIMITS.annotations} annotations per chart.`);
  const keys = new Set<string>();
  v.forEach((item: unknown, i) => {
    const key = annotation(add, `${path}[${i}]`, item);
    if (key === undefined) return;
    if (keys.has(key)) add(`${path}[${i}].key`, "unique", `duplicate annotation key "${key}".`);
    keys.add(key);
  });
}

/** The first problem with a period, as a sentence, or null when it is valid. For every problem use `validateChartCardSpec`. */
export function validatePeriod(v: unknown): string | null {
  return firstMessage((add) => period(add, "period", v));
}

/** The first problem with a symbol, as a sentence, or null when it is valid. */
export function validateSymbol(v: unknown): string | null {
  return firstMessage((add) => symbol(add, "symbol", v));
}

/** The first problem with a bar, as a sentence, or null when it is valid. */
export function validateMarketBar(v: unknown): string | null {
  return firstMessage((add) => bar(add, "", v));
}

/** The first problem with an annotation, as a sentence, or null when it is valid. */
export function validateChartAnnotation(v: unknown): string | null {
  return firstMessage((add) => void annotation(add, "", v));
}

/** The first problem with a list of annotations, as a sentence, or null when it is valid. */
export function validateChartAnnotations(v: unknown): string | null {
  return firstMessage((add) => annotations(add, "", v));
}

export function validateChartCardSpec(spec: unknown): CardValidationResult {
  const { issues, add } = collector();
  if (!isObject(spec)) {
    wrongType(add, "", spec, "Chart card spec must be an object.");
    return cardResult(issues);
  }
  oneOf(add, "kind", spec.kind, [CHART_CARD_KIND], `kind must be "${CHART_CARD_KIND}".`);
  if (spec.id !== undefined) {
    const message = "id must be a non-empty string.";
    filled(add, "id", spec.id, message);
    if (typeof spec.id === "string" && spec.id.trim() !== "" && spec.id.length > 128) add("id", "length", message);
  }
  if (spec.title !== undefined) str(add, "title", spec.title, "title must be a string.");
  symbol(add, "symbol", spec.symbol);
  period(add, "period", spec.period);
  if (spec.height !== undefined) finiteBetween(add, "height", spec.height, CHART_LIMITS.height, `height must be ${CHART_LIMITS.height[0]}..${CHART_LIMITS.height[1]} pixels.`);
  if (spec.chartType !== undefined) oneOf(add, "chartType", spec.chartType, CHART_TYPES, `chartType must be one of ${CHART_TYPES.join(", ")}.`);
  const hasBars = spec.bars !== undefined;
  const hasFeed = spec.feed !== undefined;
  if (hasBars === hasFeed) add("", "exclusive", "Provide exactly one of `bars` or `feed`.", "bars: [{timestamp, open, high, low, close, volume?}] | feed: { id }");
  if (hasBars) {
    const bars = spec.bars;
    if (!Array.isArray(bars)) wrongType(add, "bars", bars, "bars must be a non-empty array.");
    else if (bars.length === 0) add("bars", "empty", "bars must be a non-empty array.");
    else {
      if (bars.length > CHART_LIMITS.bars) add("bars", "limit", `at most ${CHART_LIMITS.bars} inline bars; reference a feed for more.`);
      let previous = -Infinity;
      bars.forEach((b: unknown, i) => {
        bar(add, `bars[${i}]`, b);
        const t = isObject(b) ? b.timestamp : undefined;
        if (typeof t !== "number" || !Number.isFinite(t)) return;
        if (t <= previous) add(`bars[${i}].timestamp`, "order", "bars must be sorted oldest first with unique timestamps.");
        previous = t;
      });
    }
  }
  if (hasFeed) {
    const message = "feed needs a non-empty id.";
    if (!isObject(spec.feed)) wrongType(add, "feed", spec.feed, message);
    else filled(add, "feed.id", spec.feed.id, message);
  }
  if (spec.indicators !== undefined) {
    const message = `indicators must be an array of at most ${CHART_LIMITS.indicators}.`;
    if (!Array.isArray(spec.indicators)) wrongType(add, "indicators", spec.indicators, message);
    else {
      if (spec.indicators.length > CHART_LIMITS.indicators) add("indicators", "limit", message);
      spec.indicators.forEach((i: unknown, k) => {
        const p = `indicators[${k}]`;
        if (!isObject(i)) return wrongType(add, p, i, "each indicator needs a name.");
        filled(add, `${p}.name`, i.name, "each indicator needs a name.");
        if (i.params !== undefined) {
          const params = "indicator params must be an array of finite numbers.";
          if (!Array.isArray(i.params)) wrongType(add, `${p}.params`, i.params, params);
          else i.params.forEach((n: unknown, j) => finite(add, `${p}.params[${j}]`, n, params));
        }
      });
    }
  }
  if (spec.annotations !== undefined) annotations(add, "annotations", spec.annotations);
  return cardResult(issues);
}

export const chartCardKind: CardKindDefinition = {
  kind: CHART_CARD_KIND,
  summary: "A financial chart the user can pan, zoom, draw on and replay: candles or lines, indicators, and your annotations (levels, zones, markers, trend lines, rays, fibonacci retracements, trade plans).",
  schema: {
    type: "object",
    required: ["kind", "symbol", "period"],
    properties: {
      kind: { const: CHART_CARD_KIND },
      id: { type: "string", description: "Stable id so later tool calls can address this chart." },
      title: { type: "string" },
      symbol: { type: "object", required: ["ticker"], properties: { ticker: { type: "string" }, name: { type: "string" }, exchange: { type: "string" }, pricePrecision: { type: ["integer", "string"] }, timezone: { type: "string" } } },
      period: { type: "object", required: ["multiplier", "timespan", "text"], properties: { multiplier: { type: "integer", minimum: 1 }, timespan: { type: "string" }, text: { type: "string" } } },
      height: { type: "number", minimum: CHART_LIMITS.height[0], maximum: CHART_LIMITS.height[1] },
      chartType: { enum: [...CHART_TYPES] },
      bars: { type: "array", description: "Inline OHLCV bars, oldest first. Use this or `feed`.", maxItems: CHART_LIMITS.bars },
      feed: { type: "object", required: ["id"], properties: { id: { type: "string" } }, description: "A datafeed the host registered." },
      indicators: { type: "array", maxItems: CHART_LIMITS.indicators, items: { type: "object", required: ["name"], properties: { name: { type: "string" }, params: { type: "array", items: { type: "number" } } } } },
      annotations: { type: "array", maxItems: CHART_LIMITS.annotations, items: { type: "object", required: ["key", "kind", "anchors"], properties: { key: { type: "string" }, kind: { enum: [...CHART_ANNOTATION_KINDS], description: "level: 1 anchor with price. zone: 2 anchors with price. marker: 1 anchor. trend and ray: 2 anchors with price. fibonacci: 2 anchors with price. plan: 3 anchors with price (entry, target, stop)." }, anchors: { type: "array", maxItems: CHART_LIMITS.anchors }, text: { type: "string" }, tone: { enum: ["bull", "bear", "neutral", "accent"] }, color: { type: "string" }, params: { type: "object", description: "Options for trend, ray, fibonacci and plan, for example { extend: \"right\" } or { levels: \"0,0.5,1\" }." } } } },
    },
  },
  validate: validateChartCardSpec,
};
