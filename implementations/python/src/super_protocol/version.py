# SPDX-License-Identifier: Apache-2.0
"""Which version of the protocol a piece of data was written against, and which features this build knows.

Ported from version.ts in the TypeScript reference (see docs/VERSIONING.md). A protocol version is "major.minor": two
plain numbers with no sign, no leading zero and at most nine digits each. "0.5" and "1.12" are versions; "0.05", "1",
"1.2.3" and "v1.2" are not. A patch release never changes it.
"""

from __future__ import annotations

import re
from typing import Any, NamedTuple

from . import _js as js

PROTOCOL_VERSION = "0.5"

# One "name@major.minor" per feature, where the version is the protocol version the feature first appeared in.
PROTOCOL_FEATURES: tuple[str, ...] = (
    "tools@0.2",
    "theme@0.2",
    "ref@0.3",
    "plot@0.3",
    "run@0.4",
    "placement@0.4",
    "issues@0.5",
    "mapping@0.5",
)

PROTOCOL_VERSION_PATTERN = re.compile(r"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})")
PROTOCOL_VERSION_MESSAGE = "must be a protocol version such as 0.5"
_FEATURE = re.compile(r"([a-z][a-z0-9-]*)@(.+)")


class ParsedProtocolVersion(NamedTuple):
    major: int
    minor: int


class ParsedProtocolFeature(NamedTuple):
    name: str
    version: ParsedProtocolVersion


def parse_protocol_version(value: Any) -> ParsedProtocolVersion | None:
    """The major and minor of a protocol version, or None when `value` is not one (including a non-string)."""
    if not js.is_string(value):
        return None
    m = PROTOCOL_VERSION_PATTERN.fullmatch(value)
    return ParsedProtocolVersion(int(m.group(1)), int(m.group(2))) if m else None


def compare_protocol_versions(a: Any, b: Any) -> int | None:
    """-1, 0 or 1 as `a` is older than, the same as or newer than `b`; None when either is not a protocol version."""
    x = parse_protocol_version(a)
    y = parse_protocol_version(b)
    if x is None or y is None:
        return None
    if x.major != y.major:
        return -1 if x.major < y.major else 1
    if x.minor != y.minor:
        return -1 if x.minor < y.minor else 1
    return 0


def parse_protocol_feature(value: Any) -> ParsedProtocolFeature | None:
    """The name and version of a feature such as "run@0.4", or None when `value` is not one."""
    if not js.is_string(value):
        return None
    m = _FEATURE.fullmatch(value)
    version = parse_protocol_version(m.group(2)) if m else None
    return ParsedProtocolFeature(m.group(1), version) if m and version else None
