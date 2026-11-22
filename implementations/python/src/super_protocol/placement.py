# SPDX-License-Identifier: Apache-2.0
"""Where a host shows a card: inline in the conversation, in its side panel, or in a document block."""

from typing import Any

CARD_PLACEMENTS: tuple[str, ...] = ("inline", "panel", "document")


def is_card_placement(value: Any) -> bool:
    return isinstance(value, str) and value in CARD_PLACEMENTS


def can_place_card(interactive: bool | None, placement: Any) -> bool:
    """Whether a kind may be shown at ``placement``; an interactive kind only inline. ``None``: no definition."""
    if not is_card_placement(placement):
        return False
    return placement == "inline" or interactive is not True
