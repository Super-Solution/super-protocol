/**
 * The `super.plot` card: a chart (bar, line, scatter, histogram and more) that
 * the user reads in the chat, from any plotting library. This file holds the
 * card kind, its spec and its validator; it is all a host or agent needs to
 * produce, route and describe the card.
 *
 * The protocol checks the envelope only. The inner `spec` is passed to whichever
 * plugin draws `super.plot` cards (Super Plot or another), so a new plot type
 * needs no protocol change.
 *
 * What the user sees, and what goes elsewhere:
 * - Drawn: the plot, with `title` above it when there is one. With no title, show
 *   no heading; never put the card kind or a field name in its place.
 * - Not drawn (a plot type or spec version the plugin does not know, bad data,
 *   a mount that throws): `PLOT_FALLBACK_MESSAGE`, then the card's `alt` when it
 *   has one. Nothing else: no error text, card kind, plugin or library name,
 *   field path or JSON.
 * - The technical reason goes to the developer log, and the host may return it
 *   to the model so it can send a corrected card. The same split applies to
 *   `validatePlotCardSpec` errors: they are written for the model and the log.
 */
import type { CardKindDefinition, CardValidationResult } from "./chat.js";

export const PLOT_CARD_KIND = "super.plot";

/** What the user sees in place of a plot that cannot be drawn, followed by the card's `alt`. */
export const PLOT_FALLBACK_MESSAGE = "This chart can't be shown here.";

export interface PlotCardSpec {
  kind: typeof PLOT_CARD_KIND;
  /** Stable id so a later tool call can address this plot. Never shown to the user. */
  id?: string;
  /**
   * Shown above the plot. Written the way the user would say it ("Revenue by
   * region"), not as a field key ("revenue_by_region").
   */
  title?: string;
  /** Height in CSS pixels. Default is the plugin's. */
  height?: number;
  /**
   * The plot spec (data, chart type, encodings). Opaque to the protocol: the
   * plugin that draws it checks it in full and reports problems to the model
   * and the log, never in the card.
   */
  spec: Record<string, unknown>;
  /**
   * What the plot shows, in a sentence or two of plain words. Read by screen
   * readers, shown under `PLOT_FALLBACK_MESSAGE` when the plot cannot be drawn,
   * kept in transcripts that cannot draw it, and read by the model in the history.
   */
  alt: string;
}

export const PLOT_LIMITS = Object.freeze({ alt: 2048, idLength: 128, height: [160, 1200] as const });

const PLOT_EXPECTED = 'spec: { ...a plot spec }, alt: "one sentence saying what the plot shows"';

const fail = (error: string, expected?: string): CardValidationResult => (expected ? { ok: false, error, expected } : { ok: false, error });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Checks the envelope. The errors are for the model and the developer log, not for the user. */
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
  summary:
    "A statistical plot (bar, line, scatter, histogram, box, heatmap and more) the user can read, hover and export. Send the plot spec and a sentence saying what it shows. Name the title, axes and series the way the user would, not by column keys.",
  schema: {
    type: "object",
    required: ["kind", "spec", "alt"],
    properties: {
      kind: { const: PLOT_CARD_KIND },
      id: { type: "string", maxLength: PLOT_LIMITS.idLength, description: "Stable id so later tool calls can address this plot. Not shown to the user." },
      title: { type: "string", description: 'Shown above the plot, in the user\'s words: "Revenue by region", not "revenue_by_region".' },
      height: { type: "number", minimum: PLOT_LIMITS.height[0], maximum: PLOT_LIMITS.height[1] },
      spec: { type: "object", description: "The plot spec: data, chart type and encodings. Give axes and series readable labels, not raw column keys." },
      alt: {
        type: "string",
        minLength: 1,
        maxLength: PLOT_LIMITS.alt,
        description: "What the plot shows, in plain words: the main values and the takeaway. Read by screen readers and shown to the user if the plot cannot be drawn.",
      },
    },
  },
  validate: validatePlotCardSpec,
};
