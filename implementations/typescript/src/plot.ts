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
import { cardResult, type CardKindDefinition, type CardValidationResult } from "./chat.js";
import { filled, finiteBetween, isObject, oneOf, str, wrongType } from "./check.js";
import { collector } from "./issue.js";

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

const PLOT_EXPECTED = 'spec: { type: "bar", data: [{ region: "EU", revenue: 12 }, { region: "US", revenue: 20 }], x: "region", y: "revenue" } (the plot itself, its data inside it), alt: "one sentence saying what the plot shows" (beside spec, not inside it)';

/** Checks the envelope. The errors are for the model and the developer log, not for the user. */
export function validatePlotCardSpec(spec: unknown): CardValidationResult {
  const { issues, add } = collector();
  if (!isObject(spec)) {
    wrongType(add, "", spec, "Plot card spec must be an object.");
    return cardResult(issues);
  }
  oneOf(add, "kind", spec.kind, [PLOT_CARD_KIND], `kind must be "${PLOT_CARD_KIND}".`);
  if (spec.id !== undefined) {
    const message = "id must be a non-empty string.";
    filled(add, "id", spec.id, message);
    if (typeof spec.id === "string" && spec.id.trim() !== "" && spec.id.length > PLOT_LIMITS.idLength) add("id", "length", message);
  }
  if (spec.title !== undefined) str(add, "title", spec.title, "title must be a string.");
  if (spec.height !== undefined) finiteBetween(add, "height", spec.height, PLOT_LIMITS.height, `height must be ${PLOT_LIMITS.height[0]}..${PLOT_LIMITS.height[1]} pixels.`);
  if (!isObject(spec.spec)) {
    const message = "spec must be an object: the plot spec.";
    if (spec.spec === undefined) add("spec", "required", message, PLOT_EXPECTED);
    else wrongType(add, "spec", spec.spec, message);
  }
  const alt = "alt must be a non-empty string saying what the plot shows.";
  if (spec.alt === undefined) add("alt", "required", alt, PLOT_EXPECTED);
  else filled(add, "alt", spec.alt, alt);
  if (typeof spec.alt === "string" && spec.alt.trim() !== "" && spec.alt.length > PLOT_LIMITS.alt) add("alt", "length", `alt must be at most ${PLOT_LIMITS.alt} characters.`);
  return cardResult(issues);
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
