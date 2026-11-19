# Conformance data

Language-neutral test data for `@supersolutions/super-protocol`. The TypeScript package in
[`../implementations/typescript`](../implementations/typescript) is the reference; every other implementation must reproduce these
cases exactly, error messages included.

| File | What it pins |
| --- | --- |
| `protocol.v1.json` | `plugin_manifest` (issue lists), `editor_card`, `chart_card` and `plot_card` (result objects), `terminal_event`, and `sse` (hex-encoded byte chunks, optional frame limit, expected frames or the error code) |

Known limits of the data: URLs are realistic base URLs (no percent-encoded or internationalised
hosts), strings are valid UTF-8 (a multi-byte character may be split across SSE chunks), and string
lengths count UTF-16 code units, as JavaScript does.

```bash
pnpm build && pnpm conformance:export       # regenerate (from the repo root)
pnpm test                                    # TypeScript still matches
(cd implementations/go && go test ./...)                     # Go port
(cd implementations/python && pytest)                        # Python port
```

If behaviour changes on purpose, regenerate, review the diff, and update every port. A closed-source
Rust implementation, if one exists, lives in a private repository and tests against this same file.
