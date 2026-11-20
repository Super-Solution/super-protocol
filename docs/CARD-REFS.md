# Card references

How text in a chat message points at something inside a card. The reader hovers or focuses the words and the part
lights up in the card; they click or press Enter and the card brings it into view. The same link works for every
card kind, so Super Chat renders it once and each card decides what it means.

## The link

A reference is an ordinary Markdown link whose address starts with `ref:`:

```md
[the support level](ref:btc?key=support)
[the March rally](ref:btc?from=1772323200000&to=1774915200000)
```

`ref:<target>?<name>=<value>&...`

| Part | Rule |
| --- | --- |
| `target` | The `id` of the card on screen. 1 to 128 of letters, digits, `.`, `_`, `:`, `-`, starting with a letter or digit. |
| names | 1 to 32 of letters, digits, `-`, `_`, starting with a lowercase letter. At most 16 distinct names. |
| values | Percent-encoded UTF-8, never empty, at most 256 characters decoded. Decoded once; never split on commas. |
| repeats | A repeated name is a list in order, `key=a&key=b`. At most 32 values per name. |
| whole link | At most 512 characters. No fragment (`#`). |

`parseCardRef` and `formatCardRef` read and write it, in TypeScript, Go and Python, with the same limits and the same
messages (`conformance/protocol.v1.json`: `card_ref_parse`, `card_ref_format`). The envelope says nothing about what a
param means.

## What a kind does with it

A card kind declares its own vocabulary next to its card type. The chart's is `parseChartRef`:

| Link | Means |
| --- | --- |
| `ref:btc` | the chart as a whole |
| `ref:btc?key=support` | the annotation with that key |
| `ref:btc?from=<ms>&to=<ms>` | a time range (milliseconds since the epoch) |
| `ref:btc?from=<ms>&to=<ms>&low=<price>&high=<price>` | a price band over that range |

Other kinds (a plot, a document) add their own names the same way. A host never needs to understand them.

## What a card does with it

A card mount handle may implement `ref(ref, event)`:

| Event | Reader did | Card does |
| --- | --- | --- |
| `enter` | hovered or focused the link | show a highlight, change nothing else |
| `leave` | moved off it | clear that highlight |
| `activate` | clicked, pressed Enter, tapped | bring the part into view and move focus to it |

`ref(null, "leave")` clears every highlight. The answer is `{ ok: true, label? }` or `{ ok: false, code, reason }`;
on `ok: false` the host shows the words as plain text and keeps the reason where a screen reader can reach it. A card
without `ref` simply never matches. Codes are the card's own (`ref_no_match` for a key or range that is not there).

## Annotation kinds on a chart card

A chart annotation may also be a `trend` line or `ray` (two priced anchors), a `fibonacci` retracement (two priced
anchors) or a `plan` (three priced anchors: entry, target, stop), with optional scalar `params` such as
`{ "extend": "right" }` or `{ "levels": "0,0.5,1" }`. The basic `level`, `zone` and `marker` are unchanged.
