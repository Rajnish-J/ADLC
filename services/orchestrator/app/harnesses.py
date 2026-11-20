"""Agent harnesses (port of the parts of packages/contracts/src/engines.ts the orchestrator needs): labels, the
project allow-list, and which harnesses are installed in a user's online VS Code windows."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection

from .db import tables as t

KNOWN_HARNESSES: dict[str, tuple[str, str]] = {
    # id: (label, tier)
    "copilot": ("GitHub Copilot", "full"),
    "claude-code": ("Claude Code", "full"),
    "codex": ("Codex", "tools"),
    "roo-code": ("Roo Code", "tools"),
    "kilo-code": ("Kilo Code", "tools"),
    "continue": ("Continue", "files"),
    "gemini": ("Gemini Code Assist", "files"),
    "amazon-q": ("Amazon Q", "files"),
    "cline": ("Cline", "files"),
}
HARNESS_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
PRESENCE_ONLINE = timedelta(minutes=3)
DEFAULT_ENGINE = "copilot"


def harness_label(harness_id: str) -> str:
    known = KNOWN_HARNESSES.get(harness_id)
    if known:
        return known[0]
    return re.sub(r"(^|-)([a-z0-9])", lambda m: (" " if m.group(1) else "") + m.group(2).upper(), harness_id)


def read_project_settings(raw: Any) -> tuple[str, list[str]]:
    """(defaultEngine, allowedEngines) — readProjectSettings semantics: an invalid default falls back."""
    data = raw if isinstance(raw, dict) else {}
    allowed_value = data.get("allowedEngines")
    allowed_raw: list[Any] = allowed_value if isinstance(allowed_value, list) else []
    allowed = list(dict.fromkeys(str(a) for a in allowed_raw if isinstance(a, str) and HARNESS_ID.match(a)))
    default = data.get("defaultEngine")
    if isinstance(default, str) and HARNESS_ID.match(default) and is_allowed(default, allowed):
        return default, allowed
    return (allowed[0] if allowed else DEFAULT_ENGINE), allowed


def is_allowed(harness_id: str, allowed: list[str]) -> bool:
    return not allowed or harness_id in allowed


@dataclass
class Window:
    client_id: str
    harnesses: set[str] = field(default_factory=set)


async def online_windows(conn: AsyncConnection, user_id: str, allowed: list[str]) -> list[Window]:
    """The user's online VS Code windows (newest first) with the allowed harnesses installed in each."""
    rows = (
        await conn.execute(
            sa.select(t.client_presence.c.client_id, t.client_presence.c.engines, t.client_presence.c.last_seen_at)
            .where(t.client_presence.c.user_id == user_id)
            .order_by(t.client_presence.c.last_seen_at.desc())
        )
    ).all()
    cutoff = datetime.now(UTC) - PRESENCE_ONLINE
    out: list[Window] = []
    for r in rows:
        if r.last_seen_at < cutoff:
            continue
        installed = {
            str(e.get("engine"))
            for e in (r.engines or [])
            if isinstance(e, dict)
            and e.get("installed", True) is not False
            and is_allowed(str(e.get("engine")), allowed)
        }
        out.append(Window(client_id=r.client_id, harnesses=installed))
    return out
