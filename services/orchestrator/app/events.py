"""Live events. Written as `pg_notify('sdlc_events', <PlatformEvent JSON>)` inside the transaction that made the
change, so they are delivered only if it commits. The gateway LISTENs and republishes them on its SSE bus.

Events carry ids only (see packages/contracts/src/events.ts); clients refetch what changed.
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection

CHANNEL = "sdlc_events"


async def publish(conn: AsyncConnection, event: dict[str, Any]) -> None:
    await conn.execute(sa.select(sa.func.pg_notify(CHANNEL, json.dumps(event, separators=(",", ":")))))


def project_changed(project_key: str, action: str, actor_id: str | None) -> dict[str, Any]:
    return {"type": "project.changed", "projectKey": project_key, "action": action, "actorId": actor_id}


def run_key(project_key: str, story_number: int | None, run_id: str) -> str:
    """How audit entries name a run: its story (`PAY-12`), or `PAY-run-1a2b3c4d` for a quick fix with no story."""
    return f"{project_key}-{story_number}" if story_number is not None else f"{project_key}-run-{run_id[:8]}"


def work_changed_run(project_key: str, story_number: int | None, run_id: str, actor_id: str | None) -> dict[str, Any]:
    return {
        "type": "work.changed",
        "projectKey": project_key,
        "storyNumber": story_number,
        "kind": "run",
        "actorId": actor_id,
        "runId": run_id,
    }
