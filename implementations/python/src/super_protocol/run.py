# SPDX-License-Identifier: Apache-2.0
"""Run events: what an agent turn reports while it runs, wherever the loop lives.

A server written in Python checks what it sends with `validate_run_event`, and anything that follows a
stream asks `run_stream_outcome` what a closed connection means. Ported from the TypeScript reference in
implementations/typescript/src/run.ts; docs/RUN-EVENTS.md has the event table. Inputs are decoded JSON.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any, Literal

from . import _js as js
from ._check import Checker
from ._js import UNDEFINED, get
from .issue import ManifestIssue, did_you_mean
from .version import PROTOCOL_VERSION_MESSAGE, PROTOCOL_VERSION_PATTERN

RUN_EVENT_TYPES = (
    "run-start",
    "run-snapshot",
    "context-built",
    "step-start",
    "text-delta",
    "reasoning-delta",
    "tool-call-input-delta",
    "tool-call",
    "awaiting-user",
    "user-responded",
    "tool-result",
    "card",
    "card-updated",
    "step-finish",
    "job-started",
    "job-status",
    "message",
    "metering",
    "usage",
    "run-finish",
    "error",
)
RUN_MODES = ("stream", "sync", "background")
# Why a step or a run stopped. "cancelled" is the person stopping it: an outcome, not a fault.
RUN_FINISH_REASONS = ("stop", "length", "tool-calls", "content-filter", "cancelled", "error", "unknown")
# What a person can do with a card that waits for them.
RUN_CARD_ACTION_TYPES = ("submit", "select", "confirm", "cancel", "dismiss")
RUN_JOB_STATUSES = ("queued", "in_progress", "completed", "failed", "cancelled", "incomplete")
_USAGE_FIELDS = ("inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens")

RunEventIssue = ManifestIssue
RunStreamOutcome = Literal["empty", "finished", "awaiting-user", "interrupted"]


class _Checker(Checker):
    def usage(self, path: str, value: Any) -> None:
        if not js.is_object(value):
            return self.wrong_type(path, value, "must be an object")
        for field in _USAGE_FIELDS:
            if get(value, field) is not UNDEFINED:
                self.amount(f"{path}.{field}", get(value, field))

    def spec(self, path: str, value: Any) -> None:
        if not js.is_object(value):
            return self.wrong_type(path, value, "must be an object")
        self.text(f"{path}.kind", get(value, "kind"))

    def action(self, path: str, value: Any) -> None:
        if not js.is_object(value):
            return self.wrong_type(path, value, "must be an object")
        self.text(f"{path}.cardId", get(value, "cardId"))
        if get(value, "callId") is not UNDEFINED:
            self.text(f"{path}.callId", get(value, "callId"))
        self.text(f"{path}.kind", get(value, "kind"))
        self.one_of(f"{path}.type", get(value, "type"), RUN_CARD_ACTION_TYPES)
        self.amount(f"{path}.at", get(value, "at"))

    def card(self, path: str, value: Any) -> None:
        if not js.is_object(value):
            return self.wrong_type(path, value, "must be an object")
        self.text(f"{path}.id", get(value, "id"))
        self.spec(f"{path}.spec", get(value, "spec"))
        if get(value, "expired") is not UNDEFINED:
            self.boolean(f"{path}.expired", get(value, "expired"))
        if get(value, "callId") is not UNDEFINED:
            self.text(f"{path}.callId", get(value, "callId"))
        if get(value, "action") is not UNDEFINED:
            self.action(f"{path}.action", get(value, "action"))

    def parts(self, path: str, value: Any) -> None:
        if not isinstance(value, list):
            return self.wrong_type(path, value, "must be an array")
        for i, part in enumerate(value):
            if not js.is_object(part):
                self.wrong_type(f"{path}[{i}]", part, "must be an object")
                continue
            self.text(f"{path}[{i}].type", get(part, "type"))

    def handle(self, path: str, value: Any) -> None:
        if not js.is_object(value):
            return self.wrong_type(path, value, "must be an object")
        self.text(f"{path}.provider", get(value, "provider"))
        self.text(f"{path}.id", get(value, "id"))

    def optional(self, event: Any, key: str, check: Callable[[str, Any], None]) -> None:
        """Runs `check` on a field only when the event has it."""
        if get(event, key) is not UNDEFINED:
            check(key, get(event, key))


def validate_run_event(value: Any) -> list[RunEventIssue]:
    """Every problem found; an empty list means the event is a valid run event.

    For whoever produces events. A follower should not refuse a stream over an event type it does not
    know (see `is_run_event_type`); later versions add types.
    """
    c = _Checker()
    if not js.is_object(value):
        c.wrong_type("", value, "event must be an object")
        return c.issues
    kind = get(value, "type")
    if not js.is_string(kind):
        c.wrong_type("type", kind, "must be a string")
        return c.issues

    def field(key: str) -> Any:
        return get(value, key)

    if kind == "run-start":
        c.text("runId", field("runId"))
        c.one_of("mode", field("mode"), RUN_MODES)
        if field("threadId") is not UNDEFINED:
            c.text("threadId", field("threadId"))
        if field("protocol") is not UNDEFINED:
            c.pattern("protocol", field("protocol"), PROTOCOL_VERSION_PATTERN, PROTOCOL_VERSION_MESSAGE)
    elif kind == "run-snapshot":
        c.parts("parts", field("parts"))
        cards = field("cards")
        if not isinstance(cards, list):
            c.wrong_type("cards", cards, "must be an array")
        else:
            for i, card in enumerate(cards):
                c.card(f"cards[{i}]", card)
        c.optional(value, "usage", c.usage)
        c.optional(value, "steps", c.count)
    elif kind == "context-built":
        c.object("trace", field("trace"))
        c.string("system", field("system"))
        names = field("toolNames")
        if not isinstance(names, list):
            c.wrong_type("toolNames", names, "must be an array")
        else:
            for i, name in enumerate(names):
                c.string(f"toolNames[{i}]", name)
    elif kind == "step-start":
        c.count("step", field("step"))
    elif kind in ("text-delta", "reasoning-delta"):
        c.string("delta", field("delta"))
        if field("id") is not UNDEFINED:
            c.text("id", field("id"))
    elif kind == "tool-call-input-delta":
        c.text("callId", field("callId"))
        c.text("name", field("name"))
        c.optional(value, "partialCard", c.spec)
        c.optional(value, "loading", c.object)
    elif kind == "tool-call":
        c.text("callId", field("callId"))
        c.text("name", field("name"))
        c.optional(value, "repaired", c.boolean)
        c.optional(value, "loading", c.object)
    elif kind == "awaiting-user":
        c.text("callId", field("callId"))
        c.card("card", field("card"))
    elif kind == "user-responded":
        c.text("callId", field("callId"))
        c.action("action", field("action"))
    elif kind == "tool-result":
        c.text("callId", field("callId"))
        c.text("name", field("name"))
        c.optional(value, "failure", c.string)
        c.amount("ms", field("ms"))
    elif kind == "card":
        c.card("card", field("card"))
    elif kind == "card-updated":
        c.text("cardId", field("cardId"))
        c.spec("spec", field("spec"))
    elif kind == "step-finish":
        c.count("step", field("step"))
        c.one_of("finishReason", field("finishReason"), RUN_FINISH_REASONS)
        c.optional(value, "usage", c.usage)
    elif kind == "job-started":
        c.handle("handle", field("handle"))
    elif kind == "job-status":
        c.handle("handle", field("handle"))
        c.one_of("status", field("status"), RUN_JOB_STATUSES)
    elif kind == "message":
        c.parts("parts", field("parts"))
    elif kind == "metering":
        c.object("record", field("record"))
    elif kind == "usage":
        c.usage("usage", field("usage"))
    elif kind == "run-finish":
        c.text("runId", field("runId"))
        c.one_of("finishReason", field("finishReason"), RUN_FINISH_REASONS)
        c.usage("usage", field("usage"))
        c.count("steps", field("steps"))
    elif kind == "error":
        c.boolean("recoverable", field("recoverable"))
    else:
        c.add("type", "enum", "unknown run event type", did_you_mean(kind, RUN_EVENT_TYPES))
        return c.issues
    if field("seq") is not UNDEFINED:
        c.count("seq", field("seq"))
    return c.issues


def is_run_event_type(event_type: Any) -> bool:
    """Whether this is a run event type this version knows. A follower skips the ones it does not."""
    return js.is_string(event_type) and event_type in RUN_EVENT_TYPES


def is_run_terminal_event(event_type: str) -> bool:
    """Whether an event of this type ends its run. Only "run-finish" does: an "error" event is followed by one."""
    return event_type == "run-finish"


def run_stream_outcome(events: Iterable[Any]) -> RunStreamOutcome:
    """What a stream that has stopped says about its run.

    Call it when the connection closes, with every event the stream delivered, in order. A closed
    connection is not the end of a run: a run that waits for approval closes its stream and stays
    suspended, and a dropped connection leaves the run working on the server. Only "run-finish" ends
    it. Values that are not run events of a known type are skipped. "run-start" and "run-snapshot"
    start the picture over.
    """
    seen = finished = False
    waiting: set[str] = set()
    for event in events:
        kind = get(event, "type")
        if not is_run_event_type(kind):
            continue
        seen = True
        call_id = get(event, "callId")
        if not js.is_string(call_id):
            call_id = ""
        if kind in ("run-start", "run-snapshot"):
            finished = False
            waiting.clear()
        elif kind == "awaiting-user":
            finished = False
            waiting.add(call_id)
        elif kind in ("user-responded", "tool-result"):
            waiting.discard(call_id)
        elif kind == "run-finish":
            finished = True
            waiting.clear()
    if not seen:
        return "empty"
    if finished:
        return "finished"
    return "awaiting-user" if waiting else "interrupted"
