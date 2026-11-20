"""Audit writes — always inside the transaction that makes the change (port of apps/api/src/audit.ts)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from .db import tables as t


def _clean(data: dict[str, Any] | None) -> dict[str, Any]:
    # JSON.stringify drops `undefined` values; mirror that for `None` so audit rows look the same as before.
    return {k: v for k, v in (data or {}).items() if v is not None}


async def write_audit(
    conn: AsyncConnection,
    *,
    org_id: str,
    project_id: str | None,
    actor_user_id: str | None,
    action: str,
    resource_type: str,
    resource_id: str,
    via: str,
    data: dict[str, Any] | None = None,
) -> None:
    await conn.execute(
        t.audit_log.insert().values(
            org_id=org_id,
            project_id=project_id,
            actor_user_id=actor_user_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            data=_clean(data),
            via=via,
        )
    )
