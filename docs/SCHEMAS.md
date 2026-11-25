# JSON Schema

`schemas/` holds the shapes a program that is not written in TypeScript, Go or Python has to produce or read, as JSON
Schema 2020-12 (the dialect MCP uses). A Swift, Kotlin, Java or .NET client can generate its types from them without
reading the TypeScript.

| File | Shape |
| --- | --- |
| `plugin-manifest.schema.json` | `PluginManifest`, with the optional `service` and `protocol` |
| `run-event.schema.json` | One run event, a `oneOf` over the 21 event types, discriminated by `type` |
| `run-card.schema.json` | A card in a run: `id`, `spec`, and the person's `action` once they answered |
| `card-spec.schema.json` | The envelope every card spec shares: a `kind` that routes it |
| `card-response.schema.json` | What the person did with an interactive card |
| `card-super-plot.schema.json`, `card-super-chart.schema.json`, `card-super-editor.schema.json` | The spec of each card kind, as the model is shown it |
| `inference-request.schema.json`, `inference-message.schema.json` | What a gateway accepts |
| `stream-event.schema.json` | One event of a gateway's stream, a `oneOf` over the 7 types |
| `host-theme.schema.json` | `HostTheme`: a mode and any subset of the tokens |

Each file is standalone (its `$defs` are inside it) and has an `$id` that is the file's address on `main`.

## What a schema does not say

A schema describes structure. It does not replace the validators: a rule across fields (a duplicate capability id, a
tool result that answers no call, bars out of order, a limit that counts UTF-16 units) is checked by the validators and
pinned by `conformance/protocol.v1.json`, and every schema says so in its `description`. Two promises hold and are tested
on every case of the conformance data (`implementations/typescript/src/schemas.test.ts`):

1. **A value the validator accepts validates against the schema.** The schema is never stricter than the validator.
2. **A value the validator refuses is refused by the schema**, for the five schemas that are written from a field table
   (manifest, run event, inference request and message, stream event), with two exceptions: a rule across fields
   (`unique`, `reference` issues), and a URL, where the schema checks the scheme and the validator checks that it parses.

Where a schema is looser than its validator it is looser in the safe direction: it accepts something the validator will
still refuse, never the other way round.

## The card kinds' schemas

The three `card-super-*` files are the `schema` of each card kind (`CardKindDefinition.schema`), published as it is,
because that is the one the model is shown and there should be one source for it. It is written by hand beside each
validator and is looser: of the conformance cases the validator refuses, the schema also accepts 14 of 33 for the editor
card, 97 of 179 for the chart card and 6 of 47 for the plot card, mostly rules across fields (bars out of order, anchors
that must agree with the annotation kind). Promise 1 holds for them; promise 2 does not, and a test fails if the schema
ever refuses a spec the validator accepts. Use the validator for the answer, the schema for the shape.

## Generating and checking

```bash
pnpm build && pnpm schemas:export        # write schemas/
node scripts/export-schemas.mjs --check  # what scripts/check-all.sh runs
```

The word lists (event types, modes, finish reasons, theme tokens) come from the built package, so a type added to a
validator cannot be left out of its schema: the generator stops when the two disagree. The rest is a small field table in
`scripts/export-schemas.mjs`.

The schemas are not part of the npm package: `schemas/` is at the root of the repository, next to `conformance/`.
Whether to ship them in the tarball is left to the maintainers.

`ajv` is a devDependency of the TypeScript package, used by the test only; the package has no runtime dependency.
