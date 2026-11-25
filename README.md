# Super Protocol

The shared contract of the Super Solution libs, as one Apache-2.0 specification with three
implementations that are tested against the same data.

```
conformance/                 language-neutral test data (protocol.v1.json, the agent-loop files) and index.json, which lists every file, its sections and case counts
implementations/typescript/  @supersolutions/super-protocol, the reference (types + validators + SSE parser)
implementations/go/          Go port (standard library only)
implementations/python/      Python port, package `super-protocol` (standard library only)
implementations/rust-agent-loop/  Rust crate `super-agent-loop`: the agent loop as a state machine, tool-argument repair, a driver, an OpenAI Chat Completions provider and an HTTP transport (not published)
scripts/                   conformance generators and the local gate
```

## What it is for

A host (super-chat) must be able to load a plugin (super-editor, super-chart, a third party's) and
talk to an inference gateway (super-router) **without depending on any of their packages or
licenses**. This repository is that neutral ground:

- **Plugin manifest and chat plugin**: what a plugin declares (capabilities, card kinds, tools) and
  how a host mounts it, framework-neutral.
- **Inference gateway and stream events**: the request, usage and stream-event types plus an
  incremental SSE parser.
- **Run events**: what an agent turn reports while it runs (text, tool calls, cards that wait for the person, usage,
  the end), the same whether the loop runs in the page or on a server in any language, and what a stream that
  stopped means for its run (see [`docs/RUN-EVENTS.md`](docs/RUN-EVENTS.md)).
- **Agent loop** (draft, not published): what one agent turn *decides* (steps, tool dispatch, approvals, stop conditions,
  repeated-call guard, checkpoint and resume), as a state machine with no I/O, and what to do with malformed tool
  arguments. Pinned by `conformance/agent-loop.v0.json` and `conformance/tool-repair.v0.json`, which a TypeScript machine,
  a Rust crate and Super Chat's real `runAgent` are all tested against, plus a shadow replay of whole runs from wire bytes
  (`conformance/agent-loop-replay.v0.json`, expected values produced by `runAgent`; see [`docs/AGENT-LOOP.md`](docs/AGENT-LOOP.md)).
- **Card references**: the `ref:` link that lets text in a message point into a card, and the `ref()` method a card
  answers it with (see [`docs/CARD-REFS.md`](docs/CARD-REFS.md)).
- **Card placement**: the same card shown inline in a conversation, in a host's side panel or inside a
  document block, drawn by the same mount (see [`docs/CARD-PLACEMENT.md`](docs/CARD-PLACEMENT.md)).
- **Card contracts**: the `super-editor.document`, `super-chart.chart` and `super.plot` card kinds,
  the chart annotation spec and the market-data `Datafeed` contract. `super.plot` lets a host show a
  chart from any plotting library without knowing which one (see below).

Because everything here is Apache-2.0, an Apache host and a GPL/AGPL or commercial plugin can both
import it. Closed-source implementations (for example a Rust one) can follow the same conformance
data without sharing code.

## The rule

This package never imports from a GPL/AGPL package and has no runtime dependencies. The TypeScript
test `implementations/typescript/src/boundary.test.ts` fails if that changes.

## The `super.plot` card

Put a bar, line, scatter or other chart in a chat reply, drawn by whichever plugin the host has
installed (Super Plot or your own). New plot types ship in the plugin; the protocol and the host stay
as they are.

```ts
{ kind: "super.plot", spec, alt, id?, title?, height? }
```

- `spec`: the plot itself (data, chart type, encodings), passed to the plugin unchanged. The protocol
  checks only the fields around it.
- `alt` (required, at most 2,048 characters): a sentence or two in plain words saying what the plot
  shows. Screen readers read it, transcripts that cannot draw the plot keep it, and the model reads it
  in the history.
- `title`: shown above the plot, in the user's words ("Revenue by region", not
  "revenue_by_region"). With no title, the card has no heading.
- `id` lets a later tool call address the plot; `height` is 160 to 1,200 CSS pixels.

When the plot can't be drawn (a plot type or spec version the plugin doesn't know, bad data, a mount
that throws), the user sees `PLOT_FALLBACK_MESSAGE`, "This chart can't be shown here.", followed by the
card's `alt`. The technical reason goes to the developer log, and the host may return it to the model
so it can send a corrected card. Validation errors (`error`, `expected`) follow the same split: they
are written for the model and the log. The user never sees card kinds, field paths, library names or
JSON.

For market data from a datafeed (candles, indicators, annotations), use `super-chart.chart`, whose
fixed shape this protocol validates in full.

## Conformance

`conformance/protocol.v1.json` holds the cases of every shape in this repository: plugin manifests, editor, chart and plot
cards, card references, card placement, terminal events, run events, SSE byte streams. The TypeScript package produces them;
Go and Python must reproduce every case exactly, error messages included. How many cases each section holds is in
[`conformance/index.json`](conformance/index.json), which the gate regenerates and checks, so no document repeats a count
that can drift. See [`conformance/README.md`](conformance/README.md). If behaviour changes on purpose, regenerate, review
the diff and update every port.

## Develop

```bash
bash scripts/check-all.sh        # typescript, conformance reproducibility, go, python
SKIP_PYTHON=1 bash scripts/check-all.sh
```

Requires Node 20 or newer (the TypeScript gate was run on 20, 22 and 24) with pnpm 9, Go 1.22+ and Python 3.10+; the Rust crate is
checked too unless `SKIP_RUST=1`. Hosted CI is not used; the script above is the gate.

## Status

v0. Shapes may change before 1.0. The TypeScript package `@supersolutions/super-protocol` is published to npm by the manual
workflow in [`docs/NPM-PUBLISHING.md`](docs/NPM-PUBLISHING.md). The Go and Python ports and the Rust crate are not published
anywhere yet; use a local checkout.

## Contributing

External pull requests are not accepted yet: a contributor license agreement is still to be set up
(it keeps dual licensing and closed-source implementations possible). Issues are welcome.

## License

Apache-2.0. Copyright 2026 SUPER SOLUTION LABS INC. Commercial contact: contact@supersolution.io.
