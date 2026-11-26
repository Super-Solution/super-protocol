# SPDX-License-Identifier: Apache-2.0
"""What a validator says about a value it refuses.

An issue says where (`path`), what kind of problem (`code`), a sentence for a person or a model (`message`) and,
sometimes, how to fix it (`hint`, left out when there is none). `code` is the contract: a small closed set that is the
same in every language, so a program can branch on it. `message` is for reading and is pinned by the conformance data
byte for byte; do not parse it. docs/ISSUES.md says when each code is used.
"""

from __future__ import annotations

from typing import Any, TypedDict

# The vocabulary of `Issue["code"]`. Adding one is a protocol change.
ISSUE_CODES = (
    "required",
    "type",
    "empty",
    "enum",
    "range",
    "length",
    "limit",
    "format",
    "unique",
    "exclusive",
    "order",
    "reference",
    "shape",
)


class _IssueFields(TypedDict):
    path: str
    code: str
    message: str


class Issue(_IssueFields, total=False):
    hint: str


# The name this package used before issues carried a code; it is the same type.
ManifestIssue = Issue


def json_type(value: Any) -> str:
    """The JSON type of a value as a person would name it."""
    if value is None:
        return "null"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (int, float)):
        return "number"
    return "undefined"


def edit_distance(a: str, b: str) -> int:
    """The edit distance between two strings, counted in code points."""
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        nxt = [i]
        for j, y in enumerate(b, 1):
            nxt.append(min(row[j] + 1, nxt[j - 1] + 1, row[j - 1] + (0 if x == y else 1)))
        row = nxt
    return row[len(b)]


def did_you_mean(value: Any, allowed: tuple[str, ...] | list[str]) -> str | None:
    """The hint of an `enum` issue: `did you mean "x"?` for a string within two edits of one of `allowed` (the first of
    equally close ones), or None when `value` is not a string or nothing is close."""
    if not isinstance(value, str):
        return None
    best: str | None = None
    best_distance = 3
    for candidate in allowed:
        if abs(len(candidate) - len(value)) > 2:
            continue
        d = edit_distance(value, candidate)
        if d < best_distance:
            best, best_distance = candidate, d
    return None if best is None else f'did you mean "{best}"?'
