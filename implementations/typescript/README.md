# @supersolutions/super-protocol

The Apache-2.0 contract layer shared by the Super Solution libs. It holds types and small
validators only, with no runtime dependencies, so an Apache-licensed host such as super-chat can
depend on it while a plugin (super-editor, super-chart, ...) stays GPL/AGPL or commercial.

Rule: this package must never import from a GPL/AGPL package. `src/boundary.test.ts` enforces it.

| subpath | what it defines |
| --- | --- |
| `@supersolutions/super-protocol/plugin` | `PluginManifest` v0 and `validatePluginManifest` |
| `@supersolutions/super-protocol/chat` | `ChatPlugin`: card kinds, framework-neutral `CardMount`, tools with declared authority, `validateChatPlugin` |
| `@supersolutions/super-protocol/router` | `InferenceGateway`, request/usage/stream-event types including tool calls and image parts, `parseSSE`, `collectText` |
| `@supersolutions/super-protocol/run` | `RunEvent`: what an agent turn reports while it runs, in the page or on a server; `validateRunEvent` for the side that sends them and `runStreamOutcome` for what a stopped stream means ([`docs/RUN-EVENTS.md`](../../docs/RUN-EVENTS.md)) |
| `@supersolutions/super-protocol/placement` | `CardPlacement` (`inline`, `panel`, `document`), `isCardPlacement`, `canPlaceCard`: where a host shows a card; the mount is told through `CardMountContext.placement` ([`docs/CARD-PLACEMENT.md`](../../docs/CARD-PLACEMENT.md)) |
| `@supersolutions/super-protocol/plot` | the `super.plot` card kind: a chart from any plotting library in chat, with `alt` text and the plain `PLOT_FALLBACK_MESSAGE` the user sees when it can't be drawn; new plot types need no protocol change |
| `@supersolutions/super-protocol/theme` | `HostTheme`: the colour and font tokens a host passes to plugin cards, as `--super-*` variables |
| `@supersolutions/super-protocol/ref` | the `ref:` link text uses to point into a card: `parseCardRef`, `formatCardRef`, `parseChartRef` ([`docs/CARD-REFS.md`](../../docs/CARD-REFS.md)) |
| `@supersolutions/super-protocol/editor` | the `super-editor.document` card kind, its spec and validator |
| `@supersolutions/super-protocol/chart` | market-data contracts (`Datafeed`, `MarketBar`, `SymbolInfo`, `Period`), the annotation spec and the `super-chart.chart` card kind with its validator |

The root entry re-exports all of them. Node 20 or newer; the types reference the DOM (`HTMLElement`, in `CardMount`), so a
server-side project that only validates may need `"lib": ["DOM"]` in its tsconfig or `skipLibCheck`.

```ts
import { validateChatPlugin } from "@supersolutions/super-protocol/chat";
const issues = validateChatPlugin(plugin); // [] when the plugin is loadable
```

## Plugin tool authority

A `PluginTool` declares `authority: "read" | "draft" | "act"`. `PLUGIN_TOOL_PRESETS` says which presets grant
each one. A host must keep a tool with a missing or unknown authority out of every preset. `confirm: true` means
the host asks the user before each run and passes `confirmed: true` to `run`.

## Plugin surfaces

The manifest can declare `card`, `tool`, `panel` and `canvas` capabilities. Declaring a surface does not mean a
host renders it: check the host's documentation. A `panel` capability may name a `cardKind`: that card kind is
made for the host's side panel and is drawn by the same mount, told `placement: "panel"` (`panelCardKinds`).
Super Chat renders `card`, offers `tool`, and from 0.4.0 shows cards in its side panel.

Status: v0. Shapes may change before 1.0; the router types match the Super Router HTTP API as
implemented today.

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test   # from the repository root
```

License: Apache-2.0. Copyright 2026 SUPER SOLUTION LABS INC.
