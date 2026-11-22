# Card placement: one card, three places

A card (`{ kind, spec }`) is the unit of content an agent or a tool hands a host. **Where it is shown is a
separate choice**, and the same `CardMount` draws it in every place. This lets a chart or a plot be an extension
of a chat and of an editor at once, without a component per host.

| `CardPlacement` | Where | Typical use |
| --- | --- | --- |
| `inline` | In the conversation, inside a turn | A data card, a small price chart, a plot |
| `panel` | In the host's side panel, beside the conversation | A full chart workspace, a document editor |
| `document` | Inside a document block (a report in an editor) | A live chart or a plot inside a report |

`inline` is the default and what a host that predates placements always does.

## The contract

- `CardMountContext.placement?: CardPlacement` tells a mount where it is. Absent means `inline`.
- A mount **adapts and never refuses**: compact chrome inline, the full toolbar and the available height in a
  panel, no entrance animation and print-friendly output in a document. It must work, perhaps plainly, in all
  three.
- `canPlaceCard(kind, placement)`: an **interactive** kind (one that asks the user something and pauses the turn)
  is only ever placed `inline`. In a panel or a document nobody would see that the turn waits for an answer.
- A `panel` capability in a plugin manifest may now name a `cardKind`: that kind is made for the side panel (an
  editor, a chart workspace) and a host may open it there by default. `panelCardKinds(plugin)` lists them, and
  `validateChatPlugin` checks the plugin defines and mounts each one. A bare `panel` capability with no
  `cardKind` stays valid and names nothing a host can show.
- In a `document`, the card is read, printed and exported with the document. It must still say what it shows
  when it cannot be drawn, so a document host keeps a plain-text `alt` (and a title) beside the card's spec and
  shows that in its place.

Who decides the placement is the host's business: an agent may ask for one (Super Chat's `visualize` takes
`placement`), a tool may set one on its result, a user may move a card. The protocol only fixes the names, the
interactive rule and what a mount is told.

## Conformance

`card_placement` in `conformance/protocol.v1.json` pins `isCardPlacement` and `canPlaceCard` (for an
interactive kind, a non-interactive kind and no definition). `plugin_manifest` covers the `panel` capability's
optional `cardKind`. The Go (`IsCardPlacement`, `CanPlaceCard`) and Python (`is_card_placement`,
`can_place_card`) ports reproduce every case.
