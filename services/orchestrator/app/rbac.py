"""Roles and permissions — the same rules as packages/contracts/src/rbac.ts, loaded from the generated rbac.json.

Regenerate with `npm run emit:rbac -w @sdlc/contracts`; apps/api's drift test fails when the JSON is stale.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

_RULES_FILE = Path(__file__).with_name("rbac.json")


@cache
def _rules() -> dict[str, Any]:
    return json.loads(_RULES_FILE.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Actor:
    user_id: str
    org_role: str


def can(actor: Actor, project_role: str | None, perm: str, story_assignee_id: str | None | object = ...) -> bool:
    """Whether `actor` (holding `project_role`, None when not a member) may do `perm`.

    `story_assignee_id` is the targeted story's assignee for story-scoped permissions; leave it out (`...`) when the
    action targets no story — a developer then lacks the own-story-only permissions.
    """
    rules = _rules()
    if actor.org_role == "org_admin":
        return True
    if perm in rules["orgOnly"] or not project_role:
        return False
    if perm not in rules["rolePermissions"][project_role]:
        return False
    if project_role == "developer" and perm in rules["ownOnlyForDeveloper"]:
        return story_assignee_id is not ... and story_assignee_id == actor.user_id
    return True


def can_use_agent(actor: Actor, project_role: str | None, min_project_role: str | None) -> bool:
    if actor.org_role == "org_admin":
        return True
    if not project_role:
        return False
    if not min_project_role:
        return True
    rank = _rules()["projectRoleRank"]
    return bool(rank[project_role] >= rank[min_project_role])
