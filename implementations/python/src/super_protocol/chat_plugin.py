# SPDX-License-Identifier: Apache-2.0
"""The data part of the chat-plugin contract: tool authority and `validate_chat_plugin_data`."""

from __future__ import annotations

from typing import Any

from . import _js as js
from ._check import Checker
from ._js import UNDEFINED, get
from .issue import Issue
from .validators import validate_plugin_manifest

# What running a tool can do: "read" changes nothing, "draft" produces something the user reviews, "act" changes or
# removes existing state on the user's behalf.
PLUGIN_TOOL_AUTHORITIES = ("read", "draft", "act")
# The capability presets that grant each authority. A preset not listed here grants nothing.
PLUGIN_TOOL_PRESETS: dict[str, tuple[str, ...]] = {
    "read": ("observer", "draft", "executor"),
    "draft": ("draft", "executor"),
    "act": ("executor",),
}


def plugin_tool_authority(tool: Any) -> str | None:
    """The tool's declared authority, or None when it is missing or not one this protocol version knows (a host then
    keeps the tool out of every preset). `tool` is decoded JSON."""
    value = get(tool, "authority")
    return value if js.is_string(value) and value in PLUGIN_TOOL_AUTHORITIES else None


def validate_chat_plugin_data(plugin: Any) -> list[Issue]:
    """Checks the manifest, that every capability it declares is implemented, and the authority and confirm of each
    tool. `plugin` is decoded JSON of the form {manifest, cardKinds?: [{kind}], mounts?: [kind, ...], tools?: [{name,
    authority?, confirm?}]}: "mounts" lists the card kinds the plugin has a mount function for. The TypeScript
    reference takes the plugin object itself."""
    manifest = get(plugin, "manifest")
    issues = validate_plugin_manifest(manifest)
    if issues:
        return issues
    c = Checker()
    c.issues = issues

    def add(path: str, message: str) -> None:
        c.add(path, "reference", message)

    card_kinds, mount_list, tool_list = get(plugin, "cardKinds"), get(plugin, "mounts"), get(plugin, "tools")
    kinds: set[Any] = set()
    if isinstance(card_kinds, list):
        kinds = {get(k, "kind") for k in card_kinds if js.is_string(get(k, "kind"))}
    mounts = {k for k in mount_list if js.is_string(k)} if isinstance(mount_list, list) else set()
    tool_items = tool_list if isinstance(tool_list, list) else []
    tools = {get(t, "name") for t in tool_items if js.is_string(get(t, "name"))}
    for i, cap in enumerate(get(manifest, "capabilities")):
        p = f"capabilities[{i}]"
        surface, card_kind = get(cap, "surface"), get(cap, "cardKind")
        if surface == "card" or (surface == "panel" and card_kind is not UNDEFINED):
            if card_kind not in kinds:
                add(f"{p}.cardKind", f'plugin does not define card kind "{card_kind}"')
            if card_kind not in mounts:
                add(f"{p}.cardKind", f'plugin has no mount for card kind "{card_kind}"')
        if surface == "tool" and get(cap, "toolName") not in tools:
            add(f"{p}.toolName", f'plugin does not define tool "{get(cap, "toolName")}"')
    for i, tool in enumerate(tool_items):
        # A missing authority is allowed so older plugins still load; hosts keep such a tool out of every preset.
        if get(tool, "authority") is not UNDEFINED and plugin_tool_authority(tool) is None:
            c.one_of(f"tools[{i}].authority", get(tool, "authority"), PLUGIN_TOOL_AUTHORITIES)
        if get(tool, "confirm") is not UNDEFINED:
            c.boolean(f"tools[{i}].confirm", get(tool, "confirm"))
    return c.issues


def panel_card_kinds(manifest: Any) -> list[str]:
    """The card kinds a plugin declared for the side panel: its "panel" capabilities that name one. `manifest` is
    decoded JSON."""
    kinds: list[str] = []
    capabilities = get(manifest, "capabilities")
    for cap in capabilities if isinstance(capabilities, list) else []:
        kind = get(cap, "cardKind")
        if get(cap, "surface") == "panel" and js.is_string(kind) and kind != "" and kind not in kinds:
            kinds.append(kind)
    return kinds
