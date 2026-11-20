# SPDX-License-Identifier: Apache-2.0
"""Card references: `ref:<target>?<name>=<value>&...`, the link a chat message uses to point into a card.

Port of ref.ts; the limits and every message match the TypeScript reference, and
conformance/protocol.v1.json pins that. Inputs are decoded JSON.
"""

from __future__ import annotations

import math
import re
from typing import Any, TypedDict

from . import _js as js
from ._js import get

CARD_REF_SCHEME = "ref"
CARD_REF_LIMITS = {"length": 512, "target": 128, "names": 16, "values": 32, "name": 32, "value": 256}

_TARGET = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_NAME = re.compile(r"[a-z][A-Za-z0-9_-]{0,31}")
_RAW_VALUE = re.compile(r"(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+")
_DECIMAL = re.compile(r"-?[0-9]+(?:\.[0-9]+)?")
_UNRESERVED = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-")
_CHART_REF_PARAMS = ("key", "from", "to", "low", "high")


class CardRef(TypedDict):
    target: str
    params: dict[str, list[str]]


def _fail(error: str) -> dict[str, Any]:
    return {"ok": False, "error": error}


def _decode(raw: str) -> str | None:
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == "%":
            out.append(int(raw[i + 1 : i + 3], 16))
            i += 3
        else:
            out.append(ord(raw[i]))
            i += 1
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _encode(value: str) -> str:
    return "".join(chr(b) if b in _UNRESERVED else f"%{b:02X}" for b in value.encode("utf-8"))


def parse_card_ref(href: Any) -> dict[str, Any]:
    """Reads a `ref:` link: `{"ok": True, "ref": {...}}` or `{"ok": False, "error": ...}`."""
    if not js.is_string(href):
        return _fail("a ref must be a string.")
    if js.js_length(href) > CARD_REF_LIMITS["length"]:
        return _fail(f"a ref is at most {CARD_REF_LIMITS['length']} characters.")
    if not href.startswith(f"{CARD_REF_SCHEME}:"):
        return _fail(f'a ref starts with "{CARD_REF_SCHEME}:".')
    rest = href[len(CARD_REF_SCHEME) + 1 :]
    if "#" in rest:
        return _fail("a ref has no fragment.")
    target, has_query, query = rest.partition("?")
    if _TARGET.fullmatch(target) is None:
        return _fail("a ref target is 1 to 128 letters, digits, dot, underscore, colon or dash, starting with a letter or digit.")  # noqa: E501
    params: dict[str, list[str]] = {}
    if has_query:
        if query == "":
            return _fail("a ref query is empty.")
        for part in query.split("&"):
            name, has_eq, raw = part.partition("=")
            if not has_eq:
                return _fail("each ref param is name=value.")
            if _NAME.fullmatch(name) is None:
                return _fail("a ref param name is 1 to 32 letters, digits, dash or underscore, starting with a lowercase letter.")  # noqa: E501
            if _RAW_VALUE.fullmatch(raw) is None:
                return _fail("a ref param value is not empty and uses letters, digits, dot, dash, underscore, tilde or %XX only.")  # noqa: E501
            value = _decode(raw)
            if value is None:
                return _fail("a ref param value must be valid UTF-8.")
            if js.js_length(value) > CARD_REF_LIMITS["value"]:
                return _fail(f"a ref param value is at most {CARD_REF_LIMITS['value']} characters.")
            if name not in params:
                if len(params) >= CARD_REF_LIMITS["names"]:
                    return _fail(f"a ref has at most {CARD_REF_LIMITS['names']} param names.")
                params[name] = []
            if len(params[name]) >= CARD_REF_LIMITS["values"]:
                return _fail(f"a ref param has at most {CARD_REF_LIMITS['values']} values.")
            params[name].append(value)
    return {"ok": True, "ref": {"target": target, "params": params}}


def format_card_ref(ref: Any) -> str | None:
    """Writes a reference as a `ref:` link, names in alphabetical order, or None when it breaks a limit."""
    target = get(ref, "target")
    if not js.is_object(ref) or not js.is_string(target) or _TARGET.fullmatch(target) is None:
        return None
    params = get(ref, "params")
    if not js.is_object(params) or len(params) > CARD_REF_LIMITS["names"]:
        return None
    parts: list[str] = []
    for name in sorted(params):
        values = params[name]
        if _NAME.fullmatch(name) is None or not isinstance(values, list):
            return None
        if len(values) == 0 or len(values) > CARD_REF_LIMITS["values"]:
            return None
        for value in values:
            if not js.is_string(value) or value == "" or js.js_length(value) > CARD_REF_LIMITS["value"]:
                return None
            parts.append(f"{name}={_encode(value)}")
    href = f"{CARD_REF_SCHEME}:{target}" + (f"?{'&'.join(parts)}" if parts else "")
    return None if js.js_length(href) > CARD_REF_LIMITS["length"] else href


def parse_chart_ref(ref: CardRef) -> dict[str, Any]:
    """Reads the chart vocabulary (`key`, or `from`/`to` with optional `low`/`high`) from a parsed reference."""
    values: dict[str, float] = {}
    key: str | None = None
    for name in _CHART_REF_PARAMS:
        if name not in ref["params"]:
            continue
        items = ref["params"][name]
        if len(items) != 1:
            return _fail(f"a chart ref takes one {name}.")
        if name == "key":
            key = items[0]
            continue
        number = float(items[0]) if _DECIMAL.fullmatch(items[0]) else math.nan
        if not math.isfinite(number):
            return _fail(f"a chart ref {name} must be a plain decimal number.")
        values[name] = 0.0 if number == 0 else number
    chart: dict[str, Any] = {"chartId": ref["target"]}
    start, end, low, high = values.get("from"), values.get("to"), values.get("low"), values.get("high")
    if key is not None:
        if start is not None or end is not None or low is not None or high is not None:
            return _fail("a chart ref uses key or a time range, not both.")
        if js.js_length(key) > 128:
            return _fail("a chart ref key is at most 128 characters.")
        chart["key"] = key
        return {"ok": True, "chart": chart}
    if (start is None) != (end is None):
        return _fail("a chart ref time range needs both from and to.")
    if start is not None and end is not None:
        if start > end:
            return _fail("a chart ref from must not be after to.")
        chart["from"], chart["to"] = start, end
    if (low is None) != (high is None):
        return _fail("a chart ref price band needs both low and high.")
    if low is not None and high is not None:
        if start is None:
            return _fail("a chart ref price band needs a time range.")
        if low > high:
            return _fail("a chart ref low must not be above high.")
        chart["low"], chart["high"] = low, high
    return {"ok": True, "chart": chart}
