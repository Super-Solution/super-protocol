# SPDX-License-Identifier: Apache-2.0
"""The small checks every validator is built from.

A validator reports every problem it finds through `add(path, code, message, hint=None)`; these are the common shapes
of one problem (a required text, a value from a list, a count), so the same words and the same codes come out as in
the TypeScript reference.

A value that is absent is "required"; one of the wrong JSON type is "type" (with a hint saying what it was); the right
type but not acceptable is the code that says why ("empty", "enum", "range", ...).
"""

from __future__ import annotations

import re
from typing import Any

from . import _js as js
from .issue import Issue, did_you_mean, json_type


def is_count(value: Any) -> bool:
    return js.is_integer(value) and value >= 0


def is_amount(value: Any) -> bool:
    return js.finite(value) and value >= 0


class Checker:
    def __init__(self) -> None:
        self.issues: list[Issue] = []

    def add(self, path: str, code: str, message: str, hint: str | None = None) -> None:
        issue: Issue = {"path": path, "code": code, "message": message}
        if hint is not None:
            issue["hint"] = hint
        self.issues.append(issue)

    def wrong_type(self, path: str, value: Any, message: str) -> None:
        """"required" when `value` is absent, otherwise "type" with what was received."""
        if value is js.UNDEFINED:
            self.add(path, "required", message)
        else:
            self.add(path, "type", message, f"got {json_type(value)}")

    def text(self, path: str, value: Any, message: str = "must be a non-empty string") -> None:
        if not js.is_string(value):
            self.wrong_type(path, value, message)
        elif value == "":
            self.add(path, "empty", message)

    def filled(self, path: str, value: Any, message: str) -> None:
        """Like `text`, but a string of only whitespace is "empty" too."""
        if not js.is_string(value):
            self.wrong_type(path, value, message)
        elif js.trim(value) == "":
            self.add(path, "empty", message)

    def one_of(self, path: str, value: Any, allowed: tuple[str, ...], message: str | None = None) -> None:
        if js.is_string(value) and value in allowed:
            return
        message = message if message is not None else f"must be one of {', '.join(allowed)}"
        if value is js.UNDEFINED:
            self.add(path, "required", message)
        else:
            self.add(path, "enum", message, did_you_mean(value, allowed))

    def count(self, path: str, value: Any) -> None:
        message = "must be a non-negative integer"
        if not js.is_number(value):
            self.wrong_type(path, value, message)
        elif not is_count(value):
            self.add(path, "range", message)

    def amount(self, path: str, value: Any) -> None:
        message = "must be a non-negative number"
        if not js.is_number(value):
            self.wrong_type(path, value, message)
        elif not is_amount(value):
            self.add(path, "range", message)

    def finite_number(self, path: str, value: Any, message: str) -> None:
        """A finite number: "type" for anything that is not a number, "range" for one that is not finite."""
        if not js.is_number(value):
            self.wrong_type(path, value, message)
        elif not js.finite(value):
            self.add(path, "range", message)

    def finite_between(self, path: str, value: Any, low: float, high: float, message: str) -> None:
        """A finite number inside [low, high]: "type" for a non-number, "range" for one outside."""
        if not js.is_number(value):
            self.wrong_type(path, value, message)
        elif not (js.finite(value) and low <= value <= high):
            self.add(path, "range", message)

    def short(self, path: str, value: Any, limit: int, message: str) -> None:
        """A string of at most `limit` UTF-16 units: "type", else "length"."""
        if not js.is_string(value):
            self.wrong_type(path, value, message)
        elif js.js_length(value) > limit:
            self.add(path, "length", message)

    def pattern(self, path: str, value: Any, regex: re.Pattern[str], message: str) -> None:
        """A string that matches `regex` entirely: "type" for a non-string, "format" for one that does not match."""
        if not js.is_string(value):
            self.wrong_type(path, value, message)
        elif regex.fullmatch(value) is None:
            self.add(path, "format", message)

    def object(self, path: str, value: Any, message: str = "must be an object") -> None:
        if not js.is_object(value):
            self.wrong_type(path, value, message)

    def string(self, path: str, value: Any, message: str = "must be a string") -> None:
        if not js.is_string(value):
            self.wrong_type(path, value, message)

    def boolean(self, path: str, value: Any, message: str = "must be a boolean") -> None:
        if not isinstance(value, bool):
            self.wrong_type(path, value, message)
