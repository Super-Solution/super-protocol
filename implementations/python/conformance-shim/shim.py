# SPDX-License-Identifier: Apache-2.0
"""Answers scripts/conformance-run.mjs with this Python port, one JSON line per case (docs/CONFORMANCE-RUNNER.md).

    node scripts/conformance-run.mjs --command "python3 implementations/python/conformance-shim/shim.py"

Read a line, compute the result, write a line. A section that is not in HANDLERS is answered "unsupported": the runner
reports it and does not count it as a failure.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any

import super_protocol as p

Case = dict[str, Any]


def sse(c: Case) -> Case:
    parser = p.SSEParser(c["max_frame_bytes"]) if "max_frame_bytes" in c else p.SSEParser()
    frames: list[dict[str, str]] = []
    try:
        for chunk in c["chunks"]:
            frames += [{"event": f.event, "data": f.data} for f in parser.feed(bytes.fromhex(chunk))]
        frames += [{"event": f.event, "data": f.data} for f in parser.finish()]
    except p.StreamFrameTooLarge as e:
        return {"frames": frames, "error": e.code}
    return {"frames": frames}


def mapping(c: Case) -> Case:
    try:
        if c["fn"] == "finish_from_gateway":
            return {"value": p.finish_reason_from_gateway(c["value"])}
        if c["fn"] == "finish_to_gateway":
            return {"value": p.finish_reason_to_gateway(c["value"])}
        if c["fn"] == "usage_from_meters":
            return {"value": p.run_usage_from_meters(c["meters"], c["counting"])}
        return {"value": p.meters_from_run_usage(c["usage"], c["counting"])}
    except ValueError as e:
        return {"error": str(e)}


def protocol_version(c: Case) -> Any:
    if c["fn"] == "parse":
        v = p.parse_protocol_version(c["value"])
        return None if v is None else {"major": v.major, "minor": v.minor}
    if c["fn"] == "compare":
        return p.compare_protocol_versions(c["a"], c["b"])
    f = p.parse_protocol_feature(c["value"])
    return None if f is None else {"name": f.name, "major": f.version.major, "minor": f.version.minor}


def run_event_type(c: Case) -> Case:
    return {"known": p.is_run_event_type(c["type"]), "terminal": p.is_run_terminal_event(c["type"])}


def card_placement(c: Case) -> Case:
    return {"valid": p.is_card_placement(c["value"]), "allowed": p.can_place_card(c["interactive"], c["value"])}


def host_theme(c: Case) -> Case:
    theme = p.read_host_theme(c["value"])
    return {"theme": theme, "variables": None if theme is None else p.theme_variables(theme)}


def tool_authority(c: Case) -> Case:
    authority = p.plugin_tool_authority(c["tool"])
    return {"authority": authority, "presets": [] if authority is None else list(p.PLUGIN_TOOL_PRESETS[authority])}


def chat_plugin(c: Case) -> Case:
    manifest = c["plugin"].get("manifest")
    panel = None if p.validate_plugin_manifest(manifest) else p.panel_card_kinds(manifest)
    return {"issues": p.validate_chat_plugin_data(c["plugin"]), "panel_kinds": panel}


HANDLERS: dict[str, Callable[[Case], Any]] = {
    "issue_codes": lambda c: {"codes": list(p.ISSUE_CODES)},
    "protocol": lambda c: {"version": p.PROTOCOL_VERSION, "features": list(p.PROTOCOL_FEATURES)},
    "plot_fallback_message": lambda c: p.PLOT_FALLBACK_MESSAGE,
    "did_you_mean": lambda c: p.did_you_mean(c["value"], c["allowed"]),
    "protocol_version": protocol_version,
    "mapping": mapping,
    "plugin_manifest": lambda c: p.validate_plugin_manifest(c["value"]),
    "editor_card": lambda c: p.validate_editor_card_spec(c["value"]),
    "chart_card": lambda c: p.validate_chart_card_spec(c["value"]),
    "plot_card": lambda c: p.validate_plot_card_spec(c["value"]),
    "card_ref_parse": lambda c: p.parse_card_ref(c["value"]),
    "card_ref_format": lambda c: p.format_card_ref(c["value"]),
    "chart_ref": lambda c: None if c["value"] is None else p.parse_chart_ref(c["value"]),
    "terminal_event": lambda c: p.is_terminal_event(c["type"]),
    "run_event": lambda c: p.validate_run_event(c["value"]),
    "run_event_type": run_event_type,
    "run_stream_outcome": lambda c: p.run_stream_outcome(c["events"]),
    "card_placement": card_placement,
    "host_theme": host_theme,
    "tool_authority": tool_authority,
    "chat_plugin": chat_plugin,
    "inference_message": lambda c: p.validate_inference_message(c["value"]),
    "inference_request": lambda c: p.validate_inference_request(c["value"]),
    "stream_event": lambda c: p.validate_stream_event(c["value"]),
    "inference_stream_outcome": lambda c: p.inference_stream_outcome(c["events"]),
    "sse": sse,
}


def main() -> None:
    for line in sys.stdin:
        request = json.loads(line)
        answer: dict[str, Any] = {"id": request["id"]}
        handler = HANDLERS.get(request["section"])
        if handler is None:
            answer["unsupported"] = True
        else:
            try:
                answer["result"] = handler(request["case"])
            except Exception as e:  # reported to the runner as a failure of this case, not a crash of the program
                answer["error"] = f"{type(e).__name__}: {e}"
        sys.stdout.write(json.dumps(answer, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
