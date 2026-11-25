# super-protocol (Python)

Plugin manifest, editor, chart and plot card validators, card references (`parse_card_ref`, `format_card_ref`,
`parse_chart_ref`), card placement (`is_card_placement`, `can_place_card`), host theme (`read_host_theme`, `theme_variables`), tool authority (`plugin_tool_authority`,
`validate_chat_plugin_data`), the gateway's request, message and stream-event validators (`validate_inference_request`,
`validate_inference_message`, `validate_stream_event`, `inference_stream_outcome`), run events (`validate_run_event`,
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
