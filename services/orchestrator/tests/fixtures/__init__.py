"""Shared test data."""

import json
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).parent


def load_story_delivery() -> dict[str, Any]:
    """STORY_DELIVERY_SPEC (packages/core/src/runtime/storyDeliverySpec.ts) as JSON — a fresh copy per call."""
    return json.loads((FIXTURES / "story_delivery.json").read_text(encoding="utf-8"))
