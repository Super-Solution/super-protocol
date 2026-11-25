# SPDX-License-Identifier: Apache-2.0
"""What a gateway accepts and what it streams back, as pure functions.

`validate_inference_message`, `validate_inference_request` and `validate_stream_event` return every problem found;
`inference_stream_outcome` says what a stopped stream means. Unknown extra keys are not refused. Ported from
router.ts in the TypeScript reference; inputs are decoded JSON.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any, Literal

from . import _js as js
from ._check import Checker
from ._js import UNDEFINED, get
from .validators import ManifestIssue

INFERENCE_ROLES = ("system", "user", "assistant", "tool")
INFERENCE_FINISH_REASONS = ("stop", "length", "tool_calls")
EXECUTION_STATUSES = ("succeeded", "failed", "cancelled", "unknown")
STREAM_EVENT_TYPES = (
    "request.started",
    "output.delta",
    "output.tool_call.delta",
    "output.tool_call.completed",
    "request.completed",
    "request.failed",
    "request.replayed",
)
InferenceStreamOutcome = Literal["empty", "completed", "failed", "replayed", "interrupted"]

_IMAGE_DETAILS = ("auto", "low", "high")
_TOOL_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
_DATA_IMAGE = re.compile(r"data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}")
_USAGE_METERS = ("input", "cached", "cache_write", "output")
_USAGE_EXTRAS = ("images", "video_ms", "audio_ms", "tasks")


class _Check(Checker):
    def tool_name(self, path: str, value: Any) -> None:
        if not js.is_string(value) or _TOOL_NAME.fullmatch(value) is None:
            self.add(path, "must be 1 to 64 letters, digits, _ or -")

    def positive(self, path: str, value: Any) -> None:
        if not (js.is_integer(value) and value >= 1):
            self.add(path, "must be a positive integer")

    def content_parts(self, path: str, parts: list[Any]) -> None:
        if not parts:
            return self.add(path, "must not be empty")
        for i, part in enumerate(parts):
            p = f"{path}[{i}]"
            if not js.is_object(part):
                self.add(p, "must be an object")
                continue
            kind = get(part, "type")
            self.one_of(f"{p}.type", kind, ("text", "image"))
            if kind == "text":
                self.string(f"{p}.text", get(part, "text"))
            if kind == "image":
                url = get(part, "url")
                if not js.is_string(url) or not (js.is_http_url(url, True) or _DATA_IMAGE.fullmatch(url)):
                    self.add(f"{p}.url", "must be an https URL or a data:image URL (png, jpeg, gif or webp, base64)")
                if get(part, "detail") is not UNDEFINED:
                    self.one_of(f"{p}.detail", get(part, "detail"), _IMAGE_DETAILS)

    def tool_calls(self, path: str, value: Any, made: set[str]) -> None:
        if not isinstance(value, list):
            return self.add(path, "must be an array")
        if not value:
            return self.add(path, "must not be empty")
        own: set[str] = set()
        for i, call in enumerate(value):
            p = f"{path}[{i}]"
            if not js.is_object(call):
                self.add(p, "must be an object")
                continue
            self.text(f"{p}.id", get(call, "id"))
            self.tool_name(f"{p}.name", get(call, "name"))
            self.string(f"{p}.arguments", get(call, "arguments"))
            call_id = get(call, "id")
            if js.is_string(call_id) and call_id != "":
                if call_id in own:
                    self.add(f"{p}.id", "duplicate tool call id")
                own.add(call_id)
        made |= own

    def message(self, path: str, value: Any, made: set[str] | None) -> None:
        """`made` is the tool call ids earlier assistant messages made, or None to skip the check that a tool result
        answers one of them."""
        if not js.is_object(value):
            return self.add(path, "must be an object")

        def at(key: str) -> str:
            return key if path == "" else f"{path}.{key}"

        role = get(value, "role")
        if not js.is_string(role) or role not in INFERENCE_ROLES:
            return self.one_of(at("role"), role, INFERENCE_ROLES)
        content = get(value, "content")
        if role == "system":
            self.string(at("content"), content)
        elif role == "user":
            if isinstance(content, list):
                self.content_parts(at("content"), content)
            elif not js.is_string(content):
                self.add(at("content"), "must be a string or an array of content parts")
        elif role == "assistant":
            if get(value, "tool_calls") is not UNDEFINED:
                self.tool_calls(at("tool_calls"), get(value, "tool_calls"), made if made is not None else set())
                if content is not UNDEFINED:
                    self.string(at("content"), content)
            else:
                self.string(at("content"), content)
        else:
            call_id = get(value, "tool_call_id")
            self.text(at("tool_call_id"), call_id)
            self.string(at("content"), content)
            if get(value, "is_error") is not UNDEFINED:
                self.boolean(at("is_error"), get(value, "is_error"))
            if made is not None and js.is_string(call_id) and call_id != "" and call_id not in made:
                self.add(at("tool_call_id"), "no earlier assistant message made this tool call")

    def usage(self, path: str, value: Any) -> None:
        if not js.is_object(value):
            return self.add(path, "must be an object")
        self.text(f"{path}.status", get(value, "status"))
        meters = get(value, "meters")
        if meters is UNDEFINED:
            return
        if not js.is_object(meters):
            return self.add(f"{path}.meters", "must be an object")
        for k in _USAGE_METERS:
            self.count(f"{path}.meters.{k}", get(meters, k))
        for k in _USAGE_EXTRAS:
            if get(meters, k) is not UNDEFINED:
                self.count(f"{path}.meters.{k}", get(meters, k))


def validate_inference_message(value: Any) -> list[ManifestIssue]:
    """Checks one message on its own: its role, its content and, for an assistant, its tool calls. Whether a tool
    result answers a call an earlier message made needs the whole conversation; `validate_inference_request` does."""
    c = _Check()
    c.message("", value, None)
    return c.issues


def validate_inference_request(value: Any) -> list[ManifestIssue]:
    """Checks a request before it is sent: whether it is well formed, not whether a given gateway can serve it."""
    if not js.is_object(value):
        return [{"path": "", "message": "request must be an object"}]
    c = _Check()
    c.text("service", get(value, "service"))
    if get(value, "service_version") is not UNDEFINED:
        c.count("service_version", get(value, "service_version"))
    c.text("customer_id", get(value, "customer_id"))
    messages = get(value, "messages")
    if not isinstance(messages, list) or not messages:
        c.add("messages", "must be a non-empty array")
    else:
        made: set[str] = set()
        for i, m in enumerate(messages):
            c.message(f"messages[{i}]", m, made)
    tools = get(value, "tools")
    if tools is not UNDEFINED:
        if not isinstance(tools, list):
            c.add("tools", "must be an array")
        else:
            names: set[str] = set()
            for i, tool in enumerate(tools):
                p = f"tools[{i}]"
                if not js.is_object(tool):
                    c.add(p, "must be an object")
                    continue
                name = get(tool, "name")
                c.tool_name(f"{p}.name", name)
                if get(tool, "description") is not UNDEFINED:
                    c.string(f"{p}.description", get(tool, "description"))
                schema = get(tool, "input_schema")
                if not js.is_object(schema) or get(schema, "type") != "object":
                    c.add(f"{p}.input_schema", 'must be a JSON Schema object with type "object"')
                if js.is_string(name) and _TOOL_NAME.fullmatch(name):
                    if name in names:
                        c.add(f"{p}.name", "duplicate tool name")
                    names.add(name)
    choice = get(value, "tool_choice")
    if choice is not UNDEFINED:
        if js.is_object(choice):
            c.tool_name("tool_choice.name", get(choice, "name"))
        elif not js.is_string(choice) or choice not in ("auto", "none", "required"):
            c.add("tool_choice", 'must be "auto", "none", "required" or { name }')
    if get(value, "max_output_tokens") is not UNDEFINED:
        c.positive("max_output_tokens", get(value, "max_output_tokens"))
    if get(value, "timeout_ms") is not UNDEFINED:
        c.positive("timeout_ms", get(value, "timeout_ms"))
    return c.issues


def validate_stream_event(value: Any) -> list[ManifestIssue]:
    """Checks one stream event of the gateway. For whoever produces events; a consumer skips a type it does not know
    (`inference_stream_outcome` does), since later versions add types."""
    if not js.is_object(value):
        return [{"path": "", "message": "event must be an object"}]
    kind = get(value, "type")
    if not js.is_string(kind):
        return [{"path": "type", "message": "must be a string"}]
    if kind not in STREAM_EVENT_TYPES:
        return [{"path": "type", "message": "unknown stream event type"}]
    c = _Check()

    def field(key: str) -> Any:
        return get(value, key)

    def has(key: str) -> bool:
        return get(value, key) is not UNDEFINED

    c.text("request_id", field("request_id"))
    c.count("sequence", field("sequence"))
    if kind == "request.started":
        c.count("service_version", field("service_version"))
    elif kind == "output.delta":
        c.string("text", field("text"))
    elif kind == "output.tool_call.delta":
        c.count("index", field("index"))
        if has("id"):
            c.text("id", field("id"))
        if has("name"):
            c.tool_name("name", field("name"))
        c.string("arguments_delta", field("arguments_delta"))
    elif kind == "output.tool_call.completed":
        c.count("index", field("index"))
        c.text("id", field("id"))
        c.tool_name("name", field("name"))
        c.string("arguments", field("arguments"))
    elif kind == "request.completed":
        c.one_of("execution_status", field("execution_status"), EXECUTION_STATUSES)
        c.text("billing_status", field("billing_status"))
        if has("finish_reason"):
            c.one_of("finish_reason", field("finish_reason"), INFERENCE_FINISH_REASONS)
        if has("usage"):
            c.usage("usage", field("usage"))
    elif kind == "request.failed":
        if has("execution_status"):
            c.one_of("execution_status", field("execution_status"), EXECUTION_STATUSES)
        if has("billing_status"):
            c.text("billing_status", field("billing_status"))
        if has("error"):
            if not js.is_object(field("error")):
                c.object("error", field("error"))
            else:
                c.text("error.code", get(field("error"), "code"))
        if has("usage"):
            c.usage("usage", field("usage"))
    return c.issues


def inference_stream_outcome(events: Iterable[Any]) -> InferenceStreamOutcome:
    """What a stream that has stopped says about its request: the first terminal event it delivered, "interrupted"
    when it stopped before one (`collectText` throws stream_interrupted for it), or "empty" when it held no stream
    event of a known type. Values that are not stream events of a known type are skipped."""
    seen = False
    for event in events:
        kind = get(event, "type")
        if not js.is_string(kind) or kind not in STREAM_EVENT_TYPES:
            continue
        seen = True
        if kind == "request.completed":
            return "completed"
        if kind == "request.failed":
            return "failed"
        if kind == "request.replayed":
            return "replayed"
    return "interrupted" if seen else "empty"
