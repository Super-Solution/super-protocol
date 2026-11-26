# SPDX-License-Identifier: Apache-2.0
"""The host theme: the colour and font tokens a host passes to plugin cards, as `--super-*` CSS variables."""

from __future__ import annotations

import re
from typing import Any, TypedDict

from . import _js as js
from ._js import get


class HostTheme(TypedDict):
    mode: str
    tokens: dict[str, str]


THEME_TOKENS = (
    "background",
    "surface",
    "surface-raised",
    "border",
    "text",
    "text-muted",
    "accent",
    "accent-contrast",
    "positive",
    "negative",
    "warning",
    "info",
    "font-sans",
    "font-mono",
    "radius",
)
THEME_VALUE_MAX_LENGTH = 256

# Rejects what could end a CSS declaration or fetch a resource. The pattern spells out the letters of url, expression
# and import in both cases and the whitespace of JavaScript's \s: Python's re.IGNORECASE folds more characters than
# JavaScript's /i does (U+017F matches s), and Python's \s is wider.
_WS = re.escape(js._JS_WHITESPACE)
_UNSAFE = re.compile(
    rf"[;{{}}<>\\]|/\*|[uU][rR][lL][{_WS}]*\(|[eE][xX][pP][rR][eE][sS][sS][iI][oO][nN][{_WS}]*\(|@[iI][mM][pP][oO][rR][tT]"
)


def is_theme_value(value: Any) -> bool:
    """Whether a value may be used as a token value."""
    return (
        js.is_string(value)
        and js.trim(value) != ""
        and js.js_length(value) <= THEME_VALUE_MAX_LENGTH
        and _UNSAFE.search(value) is None
    )


def read_host_theme(value: Any) -> HostTheme | None:
    """Reads an untrusted theme. Unknown tokens and unsafe values are dropped one by one, so a bad value costs that
    token and never the card. Returns None when the mode is not "light" or "dark"."""
    mode = get(value, "mode")
    if not js.is_string(mode) or mode not in ("light", "dark"):
        return None
    tokens = get(value, "tokens")
    out: dict[str, str] = {}
    for token in THEME_TOKENS:
        candidate = get(tokens, token)
        if is_theme_value(candidate):
            out[token] = js.trim(candidate)
    return {"mode": mode, "tokens": out}


def theme_variables(theme: HostTheme) -> dict[str, str]:
    """The theme as CSS custom properties: {"--super-text": "#111"}. Unsafe values are left out."""
    out: dict[str, str] = {}
    for token in THEME_TOKENS:
        value = theme["tokens"].get(token)
        if is_theme_value(value):
            out[f"--super-{token}"] = js.trim(value)  # type: ignore[arg-type]
    return out
