# super-protocol (Python)

Plugin manifest, editor, chart and plot card validators, run events (`validate_run_event`,
`run_stream_outcome`) and an incremental SSE parser. The TypeScript
package `@supersolutions/super-protocol` in [`../typescript`](../typescript) is the reference; this port reproduces
every case in [`../../conformance`](../../conformance/README.md), messages included. Pure standard
library, no dependencies. Inputs are decoded JSON (`json.loads`).

```bash
pip install -e ".[dev]"
pytest                    # or: PYTHONPATH=src python -m unittest discover -s tests
ruff check . && mypy
```

Known differences from JavaScript: URL checking covers realistic base URLs (scheme, credentials, host,
port) but not percent-encoded or internationalised hosts, and invalid UTF-8 in an SSE stream is not
covered by the conformance data.

Apache-2.0. Copyright SUPER SOLUTION LABS INC.
