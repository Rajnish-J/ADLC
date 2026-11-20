"""Project access: the project by key and the caller's role in it (port of apps/api/src/access.ts).

A project the caller may not see answers 404, not 403, so keys don't leak.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection

from .db import tables as t
from .errors import forbidden, not_found
from .rbac import Actor, can, can_use_agent
from .security import AuthUser


@dataclass(frozen=True)
class Project:
    id: str
    org_id: str
    key: str
    name: str
    settings: dict[str, Any]


@dataclass(frozen=True)
class ProjectAccess:
    project: Project
    role: str | None
    actor: Actor


def actor_of(user: AuthUser) -> Actor:
    return Actor(user_id=user.id, org_role=user.org_role)


async def load_project_access(conn: AsyncConnection, user: AuthUser, key: str) -> ProjectAccess:
    row = (
        await conn.execute(
            sa.select(t.projects)
            .where(
                t.projects.c.org_id == user.org_id,
                t.projects.c.key == key.upper(),
                t.projects.c.archived_at.is_(None),
            )
            .limit(1)
        )
    ).first()
    if row is None:
        raise not_found("Project")
    member = (
        await conn.execute(
            sa.select(t.project_members.c.role)
            .where(t.project_members.c.project_id == row.id, t.project_members.c.user_id == user.id)
            .limit(1)
        )
    ).first()
    role = member.role if member else None
    if role is None and user.org_role != "org_admin":
        raise not_found("Project")
    project = Project(id=row.id, org_id=row.org_id, key=row.key, name=row.name, settings=row.settings or {})
    return ProjectAccess(project=project, role=role, actor=actor_of(user))


def assert_can(access: ProjectAccess, perm: str, story_assignee_id: str | None | object = ...) -> None:
    if not can(access.actor, access.role, perm, story_assignee_id):
        raise forbidden()


def assert_can_use_agent(access: ProjectAccess, min_project_role: str | None) -> None:
    if not can_use_agent(access.actor, access.role, min_project_role):
        raise forbidden()
