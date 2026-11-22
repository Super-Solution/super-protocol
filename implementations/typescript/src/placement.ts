/**
 * Where a host shows a card. A card (`{ kind, spec }`) is the unit of content; where it goes is a
 * separate choice, made by the agent or the host, and the same `CardMount` draws it in every place:
 *
 * - `inline`: in the conversation, between the words of a turn. The default, and what a host that
 *   predates placements always does.
 * - `panel`: in the host's side panel, beside the conversation, with room for a full tool (a chart
 *   workspace, a document editor). The conversation keeps a short line that reopens it.
 * - `document`: inside a document block (a report in an editor). It is read and printed with the
 *   document, so it must still say what it shows (its `alt` or title) when it cannot be drawn.
 *
 * A mount reads `CardMountContext.placement` to adapt (a compact card inline, the full toolbar in a
 * panel, no entrance animation in a document) and must work, perhaps plainly, in all three.
 */
export type CardPlacement = "inline" | "panel" | "document";

export const CARD_PLACEMENTS: readonly CardPlacement[] = ["inline", "panel", "document"];

export function isCardPlacement(value: unknown): value is CardPlacement {
  return CARD_PLACEMENTS.includes(value as CardPlacement);
}

/**
 * Whether a card of this kind may be shown at `placement`. An interactive card asks the user
 * something and is part of the conversation's control flow, so it is only ever shown inline: in a
 * panel or a document nobody would see that the turn is waiting for an answer.
 */
export function canPlaceCard(kind: { interactive?: boolean } | undefined, placement: unknown): boolean {
  if (!isCardPlacement(placement)) return false;
  return placement === "inline" || kind?.interactive !== true;
}
