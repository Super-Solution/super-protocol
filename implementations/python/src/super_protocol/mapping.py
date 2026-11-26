# SPDX-License-Identifier: Apache-2.0
"""Conversions between the gateway's words and a run's words for the same things.

Ported from mapping.ts in the TypeScript reference. Counting input is the one place the words do not settle the
meaning, so the two usage functions take the reading of each side as an argument and never guess. Usage is decoded
JSON: a dict of numbers.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from . import _js as js
from ._js import UNDEFINED, get

InputCounting = Literal["includes-cached", "excludes-cached"]


class UsageCounting(TypedDict):
    """The reading of the gateway's `Usage.input` (`meters`) and of the run's `RunUsage.inputTokens` (`run`)."""

    meters: InputCounting
    run: InputCounting


_FROM_GATEWAY = {"stop": "stop", "length": "length", "tool_calls": "tool-calls"}
_TO_GATEWAY = {"stop": "stop", "length": "length", "tool-calls": "tool_calls"}


def finish_reason_from_gateway(reason: Any) -> str:
    """The run word for a gateway `finish_reason`. A value the gateway did not send, or one this version does not know,
    is "unknown": the run never claims a reason the gateway did not give."""
    return _FROM_GATEWAY.get(reason, "unknown") if js.is_string(reason) else "unknown"


def finish_reason_to_gateway(reason: Any) -> str | None:
    """The gateway word for a run's finish reason, or None when the gateway has none: it cannot say "content-filter",
    "cancelled", "error" or "unknown", and a value that is not a finish reason at all gets None too."""
    return _TO_GATEWAY.get(reason) if js.is_string(reason) else None


def _amount(name: str, value: Any) -> Any:
    if not (js.finite(value) and value >= 0):
        raise ValueError(f"{name} must be a non-negative number")
    return value


def run_usage_from_meters(meters: Any, counting: UsageCounting) -> dict[str, Any]:
    """A run's usage from a gateway's meters. `cache_write` has no field in `RunUsage`: when the run counts input with
    the cache in it, the written tokens are inside `inputTokens`; otherwise they are dropped. `images`, `video_ms`,
    `audio_ms` and `tasks` have no run counterpart and are dropped.

    Raises ValueError when `counting["meters"]` is "includes-cached" and `input` is smaller than `cached +
    cache_write`: the input then cannot contain them, so it is the other reading, and guessing would misreport the
    tokens."""
    input_ = _amount("meters.input", get(meters, "input"))
    cached = _amount("meters.cached", get(meters, "cached"))
    written = _amount("meters.cache_write", get(meters, "cache_write"))
    output = _amount("meters.output", get(meters, "output"))
    base = input_ - cached - written if counting["meters"] == "includes-cached" else input_
    if base < 0:
        raise ValueError(
            "meters.input is smaller than cached + cache_write, so it does not include them: use excludes-cached"
        )
    input_tokens = base + cached + written if counting["run"] == "includes-cached" else base
    return {"inputTokens": input_tokens, "outputTokens": output, "cachedInputTokens": cached}


def meters_from_run_usage(usage: Any, counting: UsageCounting) -> dict[str, Any]:
    """A gateway's meters from a run's usage. `RunUsage` does not carry `cache_write`, so it comes back as 0 and, when
    the run counts input with the cache in it, the written tokens stay inside `input`; `reasoningTokens` and
    `totalTokens` have no meter and are dropped.

    Raises ValueError when `inputTokens` or `outputTokens` is absent (a meter is a number, and an unknown count is not
    0), when a count is not a non-negative number, or when `counting["run"]` is "includes-cached" and `inputTokens` is
    smaller than `cachedInputTokens`."""
    input_tokens = _amount("usage.inputTokens", get(usage, "inputTokens"))
    output_tokens = _amount("usage.outputTokens", get(usage, "outputTokens"))
    cached_value = get(usage, "cachedInputTokens")
    cached = _amount("usage.cachedInputTokens", 0 if cached_value is UNDEFINED else cached_value)
    base = input_tokens - cached if counting["run"] == "includes-cached" else input_tokens
    if base < 0:
        raise ValueError(
            "usage.inputTokens is smaller than cachedInputTokens, so it does not include it: use excludes-cached"
        )
    input_ = base + cached if counting["meters"] == "includes-cached" else base
    return {"input": input_, "cached": cached, "cache_write": 0, "output": output_tokens}
