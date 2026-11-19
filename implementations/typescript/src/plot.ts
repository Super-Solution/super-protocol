/**
 * How a statistical plot travels through chat: the card kind, its spec and its
 * validator. The card is a thin envelope around a plot spec that the protocol
 * never reads: the renderer (Super Plot, or any other plotting lib or service)
 * validates the inner `spec` when it mounts. Hosts and agents only need this
 * file to produce, route and describe the card.
 *
 * Unlike `super-chart.chart` (market data, a fixed shape) and
 * `super-editor.document` (a document), this kind names no renderer, so any
 * plugin can implement it and the protocol does not change when a plot type is
 * added to the renderer.
 */
import type { CardKindDefinition, CardValidationResult } from "./chat.js";

export const PLOT_CARD_KIND = "super.plot";

export interface PlotCardSpec {
  kind: typeof PLOT_CARD_KIND;
  /** Stable id so a later tool call can address this plot. */
  id?: string;
  title?: string;
  /** Height in CSS pixels. Default is the renderer's. */
  height?: number;
  /**
   * The plot spec (data, chart type, encodings). Opaque to the protocol: the
   * renderer validates it in full when it mounts and says what is wrong.
   */
  spec: Record<string, unknown>;
  /**
   * What the plot shows, in a sentence or two, for screen readers, for
   * transcripts that cannot draw it and for the model that reads the history.
   */
  alt: string;
}

export const PLOT_LIMITS = Object.freeze({ alt: 2048, idLength: 128, height: [160, 1200] as const });

const PLOT_EXPECTED = 'spec: { ...a plot spec }, alt: "one sentence saying what the plot shows"';

const fail = (error: string, expected?: string): CardValidationResult => (expected ? { ok: false, error, expected } : { ok: false, error });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validatePlotCardSpec(spec: unknown): CardValidationResult {
  if (!isObject(spec)) return fail("Plot card spec must be an object.");
  if (spec.kind !== PLOT_CARD_KIND) return fail(`kind must be "${PLOT_CARD_KIND}".`);
  if (spec.id !== undefined && (typeof spec.id !== "string" || spec.id.trim() === "" || spec.id.length > PLOT_LIMITS.idLength)) return fail("id must be a non-empty string.");
  if (spec.title !== undefined && typeof spec.title !== "string") return fail("title must be a string.");
  if (spec.height !== undefined && !(finite(spec.height) && spec.height >= PLOT_LIMITS.height[0] && spec.height <= PLOT_LIMITS.height[1])) return fail(`height must be ${PLOT_LIMITS.height[0]}..${PLOT_LIMITS.height[1]} pixels.`);
  if (!isObject(spec.spec)) return fail("spec must be an object: the plot spec.", spec.spec === undefined ? PLOT_EXPECTED : undefined);
  if (typeof spec.alt !== "string" || spec.alt.trim() === "") return fail("alt must be a non-empty string saying what the plot shows.", spec.alt === undefined ? PLOT_EXPECTED : undefined);
  if (spec.alt.length > PLOT_LIMITS.alt) return fail(`alt must be at most ${PLOT_LIMITS.alt} characters.`);
  return { ok: true };
}

export const plotCardKind: CardKindDefinition = {
  kind: PLOT_CARD_KIND,
  summary: "A statistical plot (bar, line, scatter, histogram, box, heatmap and more) the user can read, hover and export. Send the plot spec and a sentence saying what it shows.",
  schema: {
    type: "object",
    required: ["kind", "spec", "alt"],
    properties: {
      kind: { const: PLOT_CARD_KIND },
      id: { type: "string", maxLength: PLOT_LIMITS.idLength, description: "Stable id so later tool calls can address this plot." },
      title: { type: "string" },
      height: { type: "number", minimum: PLOT_LIMITS.height[0], maximum: PLOT_LIMITS.height[1] },
      spec: { type: "object", description: "The plot spec, passed to the renderer as is." },
      alt: { type: "string", minLength: 1, maxLength: PLOT_LIMITS.alt, description: "What the plot shows, for screen readers and for transcripts that cannot draw it." },
    },
  },
  validate: validatePlotCardSpec,
};
