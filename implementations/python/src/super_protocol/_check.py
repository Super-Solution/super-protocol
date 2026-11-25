# SPDX-License-Identifier: Apache-2.0
"""The small checks every validator is built from.

A validator reports every problem it finds through `add(path, message)`; these are the common shapes of one problem
(a required text, a value from a list, a count), so the same words come out as in the TypeScript reference.
"""

from __future__ import annotations

from typing import Any

from . import _js as js
from .validators import ManifestIssue


def is_count(value: Any) -> bool:
    return js.is_integer(value) and value >= 0


def is_amount(value: Any) -> bool:
    return js.finite(value) and value >= 0


class Checker:
    def __init__(self) -> None:
        self.issues: list[ManifestIssue] = []

    def add(self, path: str, message: str) -> None:
        self.issues.append({"path": path, "message": message})

    def text(self, path: str, value: Any) -> None:
        if not js.is_string(value) or value == "":
            self.add(path, "must be a non-empty string")

    def one_of(self, path: str, value: Any, allowed: tuple[str, ...]) -> None:
        if not js.is_string(value) or value not in allowed:
            self.add(path, f"must be one of {', '.join(allowed)}")

    def count(self, path: str, value: Any) -> None:
        if not is_count(value):
            self.add(path, "must be a non-negative integer")

    def amount(self, path: str, value: Any) -> None:
        if not is_amount(value):
            self.add(path, "must be a non-negative number")

    def object(self, path: str, value: Any) -> None:
        if not js.is_object(value):
            self.add(path, "must be an object")

    def string(self, path: str, value: Any) -> None:
        if not js.is_string(value):
            self.add(path, "must be a string")

    def boolean(self, path: str, value: Any) -> None:
        if not isinstance(value, bool):
            self.add(path, "must be a boolean")
