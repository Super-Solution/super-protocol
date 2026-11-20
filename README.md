# Super Protocol

The shared contract of the Super Solution libs, as one Apache-2.0 specification with three
implementations that are tested against the same data.

```
conformance/                 language-neutral test data (protocol.v1.json), generated from the TypeScript reference
implementations/typescript/  @supersolutions/super-protocol, the reference (types + validators + SSE parser)
implementations/go/          Go port (standard library only)
implementations/python/      Python port, package `super-protocol` (standard library only)
scripts/                   conformance generator and the local gate
```

## What it is for

A host (super-chat) must be able to load a plugin (super-editor, super-chart, a third party's) and
talk to an inference gateway (super-router) **without depending on any of their packages or
licenses**. This repository is that neutral ground:

- **Plugin manifest and chat plugin**: what a plugin declares (capabilities, card kinds, tools) and
  how a host mounts it, framework-neutral.
- **Inference gateway and stream events**: the request, usage and stream-event types plus an
  incremental SSE parser.
- **Card references**: the `ref:` link that lets text in a message point into a card, and the `ref()` method a card
  answers it with (see [`docs/CARD-REFS.md`](docs/CARD-REFS.md)).
- **Card contracts**: the `super-editor.document`, `super-chart.chart` and generic `super.plot` card
  kinds, the chart annotation spec and the market-data `Datafeed` contract. `super.plot` is an
  envelope `{ spec, alt }` around a plot spec the protocol does not interpret (see below).

Because everything here is Apache-2.0, an Apache host and a GPL/AGPL or commercial plugin can both
import it. Closed-source implementations (for example a Rust one) can follow the same conformance
data without sharing code.

## The rule

This package never imports from a GPL/AGPL package and has no runtime dependencies. The TypeScript
test `implementations/typescript/src/boundary.test.ts` fails if that changes.

## The `super.plot` card

`{ kind: "super.plot", spec, alt, id?, title?, height? }`. `spec` is any plot spec object and is passed
to the renderer as is; the protocol checks only the envelope. `alt` (required, at most 2,048
characters) says what the plot shows, for screen readers, for transcripts that cannot draw it and
for the model that reads the history. `super.plot` names no renderer: any plugin can implement it
(Super Plot does), and adding a plot type never changes this protocol. A renderer that only knows
some spec versions rejects the rest when it mounts, with its own message. `super-chart.chart`
stays as it is: market data with a datafeed has a fixed shape worth validating here.

## Conformance

`conformance/protocol.v1.json` holds roughly 800 cases (plugin manifests, editor, chart and plot cards,
terminal events, SSE byte streams). The TypeScript package produces them; Go and Python must
reproduce every case exactly, error messages included. See
[`conformance/README.md`](conformance/README.md). If behaviour changes on purpose, regenerate, review
the diff and update every port.

## Develop

```bash
bash scripts/check-all.sh        # typescript, conformance reproducibility, go, python
SKIP_PYTHON=1 bash scripts/check-all.sh
```

Requires Node 22 with pnpm 9, Go 1.22+ and Python 3.10+. Hosted CI is not used; the script above is
the gate.

## Status

v0. Shapes may change before 1.0. Nothing is published to npm, PyPI or a Go proxy yet; until then
consumers use a workspace link or a local build (see super-chart's `docs/LOCAL-DEVELOPMENT.md`).

## Contributing

External pull requests are not accepted yet: a contributor license agreement is still to be set up
(it keeps dual licensing and closed-source implementations possible). Issues are welcome.

## License

Apache-2.0. Copyright 2026 SUPER SOLUTION LABS INC. Commercial contact: contact@supersolution.io.
