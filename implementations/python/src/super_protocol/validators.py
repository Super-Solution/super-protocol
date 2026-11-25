# SPDX-License-Identifier: Apache-2.0
"""Plugin manifest, editor, chart and plot card validators.

Ported from the TypeScript reference in implementations/typescript/; every message and every ordering of
checks matches it, and conformance/protocol.v1.json pins that. Inputs are decoded JSON.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any, TypedDict

from . import _js as js
from ._check import Checker
from ._js import UNDEFINED, get
from .issue import Issue, json_type

PLUGIN_MANIFEST_VERSION = 0
EDITOR_CARD_KIND = "super-editor.document"
CHART_CARD_KIND = "super-chart.chart"
PLOT_CARD_KIND = "super.plot"
CHART_TYPES = ("candles", "hollow-candles", "ohlc", "line", "area", "baseline", "heikin-ashi")
CHART_LIMITS = {"bars": 20000, "annotations": 256, "indicators": 12, "anchors": 3, "textLength": 2048, "keyLength": 128}
CHART_ANNOTATION_ANCHORS = {"level": 1, "zone": 2, "marker": 1, "trend": 2, "ray": 2, "fibonacci": 2, "plan": 3}
_PARAM_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,31}")
_MAX_PARAMS = 16
_MAX_PARAM_STRING = 128
CHART_HEIGHT = (160, 1200)
PLOT_LIMITS = {"alt": 2048, "idLength": 128}  # the height range is CHART_HEIGHT, as for a chart card
# What the user sees in place of a plot that cannot be drawn, followed by the card's alt. The technical reason
# goes to the developer log (and may go back to the model), never to the user.
PLOT_FALLBACK_MESSAGE = "This chart can't be shown here."
SURFACES = ("card", "panel", "tool", "canvas")
_EDITOR_MODES = ("view", "edit")
_ANNOTATION_KINDS = tuple(CHART_ANNOTATION_ANCHORS)


class CardResult(TypedDict, total=False):
    """The outcome of a card validator. `issues` is every problem found, in the order the validator checks; `error` is
    the message of the first and `expected` its example when it has one."""

    ok: bool
    error: str
    expected: str
    issues: list[Issue]


_NAME = re.compile(r"(@[a-z0-9\-~][a-z0-9\-._~]*/)?[a-z0-9\-~][a-z0-9\-._~]*")
_SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.\-]+)?(\+[0-9A-Za-z.\-]+)?")
_CAPABILITY_ID = re.compile(r"[a-z][a-z0-9\-]*(\.[a-z][a-z0-9\-]*)+")


def validate_plugin_manifest(value: Any) -> list[Issue]:
    """Every problem found; an empty list means the manifest is valid."""
    c = Checker()
    if not js.is_object(value):
        c.wrong_type("", value, "manifest must be an object")
        return c.issues

    def pattern(path: str, v: Any, regex: re.Pattern[str], message: str) -> None:
        if not js.is_string(v):
            c.wrong_type(path, v, message)
        elif regex.fullmatch(v) is None:
            c.add(path, "format", message)

    version = get(value, "manifestVersion")
    if not js.equals_number(version, PLUGIN_MANIFEST_VERSION):
        c.add("manifestVersion", "required" if version is UNDEFINED else "enum", f"must be {PLUGIN_MANIFEST_VERSION}")
    pattern("name", get(value, "name"), _NAME, "must be a valid npm package name")
    pattern("version", get(value, "version"), _SEMVER, "must be a semver string")
    c.filled("license", get(value, "license"), "must be a non-empty SPDX expression")
    capabilities = get(value, "capabilities")
    if not isinstance(capabilities, list):
        c.wrong_type("capabilities", capabilities, "must be a non-empty array")
    elif len(capabilities) == 0:
        c.add("capabilities", "empty", "must be a non-empty array")
    else:
        seen: set[str] = set()
        for i, cap in enumerate(capabilities):
            path = f"capabilities[{i}]"
            # `typeof c !== "object"`: arrays pass this test in the reference and fail the field checks.
            if not isinstance(cap, (dict, list)):
                c.wrong_type(path, cap, "must be an object")
                continue
            cap_id = get(cap, "id")
            if not js.matches(_CAPABILITY_ID, cap_id):
                pattern(f"{path}.id", cap_id, _CAPABILITY_ID, "must be a dotted lowercase id such as editor.document")
            elif cap_id in seen:
                c.add(f"{path}.id", "unique", "duplicate capability id")
            else:
                seen.add(cap_id)
            surface = get(cap, "surface")
            c.one_of(f"{path}.surface", surface, SURFACES)
            card_kind = get(cap, "cardKind")
            if surface == "card":
                c.text(f"{path}.cardKind", card_kind, "is required for card capabilities")
            if surface == "panel" and card_kind is not UNDEFINED:
                c.text(f"{path}.cardKind", card_kind, "must be a non-empty card kind when given")
            if surface == "tool":
                c.text(f"{path}.toolName", get(cap, "toolName"), "is required for tool capabilities")
            if get(cap, "inputSchema") is not UNDEFINED:
                c.object(f"{path}.inputSchema", get(cap, "inputSchema"))
    service = get(value, "service")
    if service is not UNDEFINED:
        message = "must be an http(s) URL"
        base_url = get(service, "baseUrl")
        if not js.is_object(service):
            c.add("service.baseUrl", "type", message, f"got {json_type(service)}")
        elif not js.is_string(base_url):
            c.wrong_type("service.baseUrl", base_url, message)
        elif not js.is_http_url(base_url):
            c.add("service.baseUrl", "format", message)
    return c.issues


def card_result(issues: list[Issue]) -> CardResult:
    """The result a card validator returns for the issues it collected: valid when there are none. `error` is the first
    message; `expected` is its hint when the code is "required" or "exclusive" (a sample of a valid value)."""
    if not issues:
        return {"ok": True}
    first = issues[0]
    result: CardResult = {"ok": False, "error": first["message"], "issues": issues}
    if first["code"] in ("required", "exclusive") and "hint" in first:
        result["expected"] = first["hint"]
    return result


def validate_editor_card_spec(spec: Any) -> CardResult:
    c = Checker()
    if not js.is_object(spec):
        c.wrong_type("", spec, "Editor card spec must be an object.")
        return card_result(c.issues)
    c.one_of("kind", get(spec, "kind"), (EDITOR_CARD_KIND,), f'kind must be "{EDITOR_CARD_KIND}".')
    title, mode = get(spec, "title"), get(spec, "mode")
    if title is not UNDEFINED:
        c.string("title", title, "title must be a string.")
    if mode is not UNDEFINED:
        c.one_of("mode", mode, _EDITOR_MODES, 'mode must be "view" or "edit".')
    document, service = get(spec, "document"), get(spec, "service")
    has_document, has_service = document is not UNDEFINED, service is not UNDEFINED
    if has_document == has_service:
        c.add(
            "",
            "exclusive",
            "Provide exactly one of `document` or `service`.",
            "document: {...} | service: { baseUrl, documentId }",
        )
    if has_service and mode == "edit":
        c.add("mode", "exclusive", "A service-backed document is read-only for now: use an inline document to edit.")
    if has_document:
        message = "document must be a schemaVersion 1 report document with id, title and blocks."
        if not js.is_object(document):
            c.wrong_type("document", document, message)
        else:
            schema_version = get(document, "schemaVersion")
            if not js.equals_number(schema_version, 1):
                c.add("document.schemaVersion", "required" if schema_version is UNDEFINED else "enum", message)
            if not js.is_string(get(document, "id")):
                c.wrong_type("document.id", get(document, "id"), message)
            if not js.is_string(get(document, "title")):
                c.wrong_type("document.title", get(document, "title"), message)
            if not isinstance(get(document, "blocks"), list):
                c.wrong_type("document.blocks", get(document, "blocks"), message)
    if has_service:
        message = "service needs an http(s) baseUrl and a documentId."
        if not js.is_object(service):
            c.wrong_type("service", service, message)
        else:
            base_url = get(service, "baseUrl")
            if not js.is_string(base_url):
                c.wrong_type("service.baseUrl", base_url, message)
            elif not js.is_http_url(base_url):
                c.add("service.baseUrl", "format", message)
            c.text("service.documentId", get(service, "documentId"), message)
    return card_result(c.issues)


def _first_message(fill: Callable[[Checker], Any]) -> str | None:
    c = Checker()
    fill(c)
    return c.issues[0]["message"] if c.issues else None


def _period(c: Checker, path: str, v: Any) -> None:
    if not js.is_object(v):
        return c.wrong_type(path, v, "period must be an object.")
    multiplier = get(v, "multiplier")
    message = "period.multiplier must be a positive integer."
    if not js.is_number(multiplier):
        c.wrong_type(f"{path}.multiplier", multiplier, message)
    elif not js.is_safe_integer(multiplier) or multiplier <= 0:
        c.add(f"{path}.multiplier", "range", message)
    c.filled(f"{path}.timespan", get(v, "timespan"), "period.timespan must be a non-empty string.")
    c.filled(f"{path}.text", get(v, "text"), "period.text must be a non-empty string.")


_SYMBOL_STRINGS = ("name", "shortName", "exchange", "market", "priceCurrency", "type", "logo", "timezone")


def _symbol(c: Checker, path: str, v: Any) -> None:
    if not js.is_object(v):
        return c.wrong_type(path, v, "symbol must be an object.")
    c.filled(f"{path}.ticker", get(v, "ticker"), "symbol.ticker must be a non-empty string.")
    for k in _SYMBOL_STRINGS:
        if get(v, k) is not UNDEFINED:
            c.string(f"{path}.{k}", get(v, k), f"symbol.{k} must be a string.")
    precision = get(v, "pricePrecision")
    if precision is not UNDEFINED and precision != "auto":
        message = 'symbol.pricePrecision must be an integer from 0 to 12 or "auto".'
        if not js.is_number(precision):
            c.add(f"{path}.pricePrecision", "type", message, f"got {json_type(precision)}")
        elif not (js.is_integer(precision) and 0 <= precision <= 12):
            c.add(f"{path}.pricePrecision", "range", message)


def _bar(c: Checker, path: str, v: Any) -> None:
    if not js.is_object(v):
        return c.wrong_type(path, v, "a bar must be an object.")
    for k in ("timestamp", "open", "high", "low", "close"):
        c.finite_number(f"{path}.{k}", get(v, k), f"bar.{k} must be a finite number.")
    if get(v, "volume") is not UNDEFINED:
        c.finite_number(f"{path}.volume", get(v, "volume"), "bar.volume must be a finite number.")
    o, h, low, cl = get(v, "open"), get(v, "high"), get(v, "low"), get(v, "close")
    if all(js.finite(n) for n in (o, h, low, cl)) and (h < max(o, cl, low) or low > min(o, cl)):
        c.add(path, "shape", "bar high/low must contain open and close.")


_TONES = ("bull", "bear", "neutral", "accent")


def _annotation(c: Checker, path: str, v: Any) -> str | None:
    """Checks one annotation; returns its key when the key is a usable one, so the caller can look for duplicates."""
    if not js.is_object(v):
        c.wrong_type(path, v, "an annotation must be an object.")
        return None
    key_limit, text_limit = CHART_LIMITS["keyLength"], CHART_LIMITS["textLength"]
    key_message = f"annotation.key must be a non-empty string of at most {key_limit} characters."
    key_value = get(v, "key")
    c.filled(f"{path}.key", key_value, key_message)
    key: str | None = None
    if js.is_string(key_value) and js.trim(key_value) != "":
        if js.js_length(key_value) > key_limit:
            c.add(f"{path}.key", "length", key_message)
        else:
            key = key_value
    kind_value = get(v, "kind")
    c.one_of(
        f"{path}.kind",
        kind_value,
        _ANNOTATION_KINDS,
        'annotation.kind must be "level", "zone", "marker", "trend", "ray", "fibonacci" or "plan".',
    )
    kind = kind_value if js.is_string(kind_value) and kind_value in CHART_ANNOTATION_ANCHORS else None
    anchors_message = "annotation.anchors must hold one to three anchors."
    anchors = get(v, "anchors")
    if not isinstance(anchors, list):
        c.wrong_type(f"{path}.anchors", anchors, anchors_message)
    elif len(anchors) == 0:
        c.add(f"{path}.anchors", "empty", anchors_message)
    elif len(anchors) > CHART_LIMITS["anchors"]:
        c.add(f"{path}.anchors", "limit", anchors_message)
    anchors_ok = isinstance(anchors, list) and 1 <= len(anchors) <= CHART_LIMITS["anchors"]
    if isinstance(anchors, list) and anchors_ok:
        for j, a in enumerate(anchors):
            ap = f"{path}.anchors[{j}]"
            if not js.is_object(a):
                anchors_ok = False
                c.wrong_type(ap, a, "annotation anchors need a finite time.")
                continue
            c.finite_number(f"{ap}.time", get(a, "time"), "annotation anchors need a finite time.")
            if get(a, "price") is not UNDEFINED:
                c.finite_number(f"{ap}.price", get(a, "price"), "annotation anchor price must be a finite number.")
    if kind is not None and anchors_ok and isinstance(anchors, list):
        priced = ["price" in a for a in anchors]
        needed = CHART_ANNOTATION_ANCHORS[kind]
        problem: str | None = None
        if kind == "level":
            if len(anchors) != 1 or not priced[0]:
                problem = "a level needs exactly one anchor with a price."
        elif kind == "zone":
            if len(anchors) != 2 or not all(priced):
                problem = "a zone needs two anchors, both with a price."
        elif kind == "marker":
            if len(anchors) != 1:
                problem = "a marker needs exactly one anchor."
        elif len(anchors) != needed or not all(priced):
            problem = f"a {kind} needs {needed} anchors, all with a price."
        if problem is not None:
            c.add(f"{path}.anchors", "shape", problem)
    params = get(v, "params")
    if params is not UNDEFINED:
        pp = f"{path}.params"
        if kind in ("level", "zone", "marker"):
            c.add(pp, "shape", "annotation.params applies only to trend, ray, fibonacci and plan.")
        elif not js.is_object(params):
            c.wrong_type(pp, params, "annotation.params must be an object.")
        else:
            if len(params) > _MAX_PARAMS:
                c.add(pp, "limit", f"annotation.params may hold at most {_MAX_PARAMS} entries.")
            for name, value in params.items():
                if _PARAM_NAME.fullmatch(name) is None:
                    c.add(
                        f"{pp}.{name}",
                        "format",
                        "annotation.params keys must be 1 to 32 letters, digits, dash or underscore, starting with a letter.",  # noqa: E501
                    )
                message = f"annotation.params.{name} must be a finite number, a boolean or a string of at most {_MAX_PARAM_STRING} characters."  # noqa: E501
                if isinstance(value, bool):
                    continue
                if js.is_number(value):
                    if not js.finite(value):
                        c.add(f"{pp}.{name}", "range", message)
                elif js.is_string(value):
                    if js.js_length(value) > _MAX_PARAM_STRING:
                        c.add(f"{pp}.{name}", "length", message)
                else:
                    c.add(f"{pp}.{name}", "type", message, f"got {json_type(value)}")
    if get(v, "text") is not UNDEFINED:
        c.short(f"{path}.text", get(v, "text"), text_limit, f"annotation.text must be a string of at most {text_limit} characters.")  # noqa: E501
    if get(v, "tone") is not UNDEFINED:
        c.one_of(f"{path}.tone", get(v, "tone"), _TONES, "annotation.tone must be bull, bear, neutral or accent.")
    if get(v, "color") is not UNDEFINED:
        c.short(f"{path}.color", get(v, "color"), 128, "annotation.color must be a short CSS color string.")
    return key


def _annotations(c: Checker, path: str, v: Any) -> None:
    if not isinstance(v, list):
        return c.wrong_type(path, v, "annotations must be an array.")
    if len(v) > CHART_LIMITS["annotations"]:
        c.add(path, "limit", f"at most {CHART_LIMITS['annotations']} annotations per chart.")
    keys: set[str] = set()
    for i, item in enumerate(v):
        key = _annotation(c, f"{path}[{i}]", item)
        if key is None:
            continue
        if key in keys:
            c.add(f"{path}[{i}].key", "unique", f'duplicate annotation key "{key}".')
        keys.add(key)


def validate_period(v: Any) -> str | None:
    """The first problem with a period, as a sentence, or None when it is valid."""
    return _first_message(lambda c: _period(c, "period", v))


def validate_symbol(v: Any) -> str | None:
    """The first problem with a symbol, as a sentence, or None when it is valid."""
    return _first_message(lambda c: _symbol(c, "symbol", v))


def validate_market_bar(v: Any) -> str | None:
    """The first problem with a bar, as a sentence, or None when it is valid."""
    return _first_message(lambda c: _bar(c, "", v))


def validate_chart_annotation(v: Any) -> str | None:
    """The first problem with an annotation, as a sentence, or None when it is valid."""
    return _first_message(lambda c: _annotation(c, "", v))


def validate_chart_annotations(v: Any) -> str | None:
    """The first problem with a list of annotations, as a sentence, or None when it is valid."""
    return _first_message(lambda c: _annotations(c, "", v))


def validate_chart_card_spec(spec: Any) -> CardResult:
    c = Checker()
    if not js.is_object(spec):
        c.wrong_type("", spec, "Chart card spec must be an object.")
        return card_result(c.issues)
    c.one_of("kind", get(spec, "kind"), (CHART_CARD_KIND,), f'kind must be "{CHART_CARD_KIND}".')
    spec_id, title = get(spec, "id"), get(spec, "title")
    if spec_id is not UNDEFINED:
        message = "id must be a non-empty string."
        c.filled("id", spec_id, message)
        if js.is_string(spec_id) and js.trim(spec_id) != "" and js.js_length(spec_id) > 128:
            c.add("id", "length", message)
    if title is not UNDEFINED:
        c.string("title", title, "title must be a string.")
    _symbol(c, "symbol", get(spec, "symbol"))
    _period(c, "period", get(spec, "period"))
    low, high = CHART_HEIGHT
    if get(spec, "height") is not UNDEFINED:
        c.finite_between("height", get(spec, "height"), low, high, f"height must be {low}..{high} pixels.")
    if get(spec, "chartType") is not UNDEFINED:
        c.one_of(
            "chartType", get(spec, "chartType"), CHART_TYPES, f"chartType must be one of {', '.join(CHART_TYPES)}."
        )
    bars, feed = get(spec, "bars"), get(spec, "feed")
    has_bars, has_feed = bars is not UNDEFINED, feed is not UNDEFINED
    if has_bars == has_feed:
        c.add(
            "",
            "exclusive",
            "Provide exactly one of `bars` or `feed`.",
            "bars: [{timestamp, open, high, low, close, volume?}] | feed: { id }",
        )
    if has_bars:
        if not isinstance(bars, list):
            c.wrong_type("bars", bars, "bars must be a non-empty array.")
        elif len(bars) == 0:
            c.add("bars", "empty", "bars must be a non-empty array.")
        else:
            if len(bars) > CHART_LIMITS["bars"]:
                c.add("bars", "limit", f"at most {CHART_LIMITS['bars']} inline bars; reference a feed for more.")
            previous = float("-inf")
            for i, bar in enumerate(bars):
                _bar(c, f"bars[{i}]", bar)
                t = get(bar, "timestamp")
                if not js.finite(t):
                    continue
                if t <= previous:
                    c.add(f"bars[{i}].timestamp", "order", "bars must be sorted oldest first with unique timestamps.")
                previous = t
    if has_feed:
        message = "feed needs a non-empty id."
        if not js.is_object(feed):
            c.wrong_type("feed", feed, message)
        else:
            c.filled("feed.id", get(feed, "id"), message)
    indicators = get(spec, "indicators")
    if indicators is not UNDEFINED:
        message = f"indicators must be an array of at most {CHART_LIMITS['indicators']}."
        if not isinstance(indicators, list):
            c.wrong_type("indicators", indicators, message)
        else:
            if len(indicators) > CHART_LIMITS["indicators"]:
                c.add("indicators", "limit", message)
            for k, item in enumerate(indicators):
                p = f"indicators[{k}]"
                if not js.is_object(item):
                    c.wrong_type(p, item, "each indicator needs a name.")
                    continue
                c.filled(f"{p}.name", get(item, "name"), "each indicator needs a name.")
                params = get(item, "params")
                if params is not UNDEFINED:
                    message = "indicator params must be an array of finite numbers."
                    if not isinstance(params, list):
                        c.wrong_type(f"{p}.params", params, message)
                    else:
                        for j, n in enumerate(params):
                            c.finite_number(f"{p}.params[{j}]", n, message)
    if get(spec, "annotations") is not UNDEFINED:
        _annotations(c, "annotations", get(spec, "annotations"))
    return card_result(c.issues)


_PLOT_EXPECTED = (
    'spec: { type: "bar", data: [{ region: "EU", revenue: 12 }, { region: "US", revenue: 20 }],'
    ' x: "region", y: "revenue" } (the plot itself, its data inside it),'
    ' alt: "one sentence saying what the plot shows" (beside spec, not inside it)'
)


def validate_plot_card_spec(spec: Any) -> CardResult:
    """Checks the envelope of a `super.plot` card; the inner `spec` is opaque and checked by the plugin that draws it.

    The errors are for the model and the developer log, not for the user.
    """
    c = Checker()
    if not js.is_object(spec):
        c.wrong_type("", spec, "Plot card spec must be an object.")
        return card_result(c.issues)
    c.one_of("kind", get(spec, "kind"), (PLOT_CARD_KIND,), f'kind must be "{PLOT_CARD_KIND}".')
    spec_id, title = get(spec, "id"), get(spec, "title")
    if spec_id is not UNDEFINED:
        message = "id must be a non-empty string."
        c.filled("id", spec_id, message)
        if js.is_string(spec_id) and js.trim(spec_id) != "" and js.js_length(spec_id) > PLOT_LIMITS["idLength"]:
            c.add("id", "length", message)
    if title is not UNDEFINED:
        c.string("title", title, "title must be a string.")
    low, high = CHART_HEIGHT
    if get(spec, "height") is not UNDEFINED:
        c.finite_between("height", get(spec, "height"), low, high, f"height must be {low}..{high} pixels.")
    inner = get(spec, "spec")
    if not js.is_object(inner):
        message = "spec must be an object: the plot spec."
        if inner is UNDEFINED:
            c.add("spec", "required", message, _PLOT_EXPECTED)
        else:
            c.wrong_type("spec", inner, message)
    alt = get(spec, "alt")
    message = "alt must be a non-empty string saying what the plot shows."
    if alt is UNDEFINED:
        c.add("alt", "required", message, _PLOT_EXPECTED)
    else:
        c.filled("alt", alt, message)
    if js.is_string(alt) and js.trim(alt) != "" and js.js_length(alt) > PLOT_LIMITS["alt"]:
        c.add("alt", "length", f"alt must be at most {PLOT_LIMITS['alt']} characters.")
    return card_result(c.issues)


_TERMINAL = ("request.completed", "request.failed", "request.replayed")


def is_terminal_event(event_type: str) -> bool:
    return event_type in _TERMINAL
