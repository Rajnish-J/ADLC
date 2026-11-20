"""The agent catalog of one project (port of apps/api/src/services/agents.ts).

Built-ins (project_id null), the project's repo-discovered agents and skills, and its PLATFORM agents and skills
(source `platform`, defined on the platform — e.g. by the chat's Agents and Skills assistants). Only platform entries
can be created, edited or deleted here; built-in and repo ones change where they are defined.

Also home to the zod-compatible input fields the catalog's request models use (`ZodModel`, `zod`, `zstring`, …):
the gateway's chat assistant relays validation messages to users, so they read exactly like zod v3's
("name: Enter a name.", "tools.0: String must contain at least 1 character(s)", "version: Required").
"""

from __future__ import annotations

import copy
import re
from collections.abc import Callable
from typing import Annotated, Any

import sqlalchemy as sa
from pydantic import BaseModel, BeforeValidator, ConfigDict, PlainValidator, model_validator
from pydantic_core import PydanticCustomError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..access import ProjectAccess, assert_can, assert_can_use_agent, load_project_access
from ..audit import write_audit
from ..db import tables as t
from ..db.engine import read, transaction
from ..errors import bad_request, conflict, is_unique_violation, not_found
from ..events import project_changed, publish
from ..http import parse
from ..rbac import can_use_agent
from ..security import AuthUser, Caller
from ..spec.jscompat import UNDEFINED, js_str, js_trim

# ─── zod-compatible input fields ───────────────────────────────────────────────────────────────────────────────
#
# Attributes are named after the JSON keys (camelCase, like app.spec.models) so issue paths read the same.
# Every field defaults to UNDEFINED (a missing key) and runs one PlainValidator that does what the zod chain does,
# in the same order, raising zod's message for the first failing check. Models validate their defaults, so a
# missing required key reports "Required" exactly where zod would.

_NO_DEFAULT: Any = object()
# The default of every input field: a missing key (typed Any so it can stand in for any field type).
MISSING: Any = UNDEFINED
PROJECT_ROLES = ("owner", "lead", "developer", "viewer")


def _js_type(v: Any) -> str:
    """zod's `getParsedType` name for a JSON value."""
    if v is UNDEFINED:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def zod_issue(message: str) -> PydanticCustomError:
    # No context, so pydantic leaves braces in the message alone.
    return PydanticCustomError("zod", message)


def invalid_type(expected: str, v: Any) -> PydanticCustomError:
    return zod_issue("Required" if v is UNDEFINED else f"Expected {expected}, received {_js_type(v)}")


def _js_length(s: str) -> int:
    """`String.prototype.length` — UTF-16 code units."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


Step = Callable[[str], str]


def trim(s: str) -> str:
    return js_trim(s)


def lower(s: str) -> str:
    return s.lower()


def min_len(n: int, message: str | None = None) -> Step:
    def step(s: str) -> str:
        if _js_length(s) < n:
            raise zod_issue(message or f"String must contain at least {n} character(s)")
        return s

    return step


def max_len(n: int, message: str | None = None) -> Step:
    def step(s: str) -> str:
        if _js_length(s) > n:
            raise zod_issue(message or f"String must contain at most {n} character(s)")
        return s

    return step


def matches(pattern: str, message: str = "Invalid") -> Step:
    """`.regex(/^…$/)` — the pattern is given without anchors and matched against the whole string."""
    compiled = re.compile(pattern)

    def step(s: str) -> str:
        if not compiled.fullmatch(s):
            raise zod_issue(message)
        return s

    return step


_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def uuid(s: str) -> str:
    if not _UUID.fullmatch(s):
        raise zod_issue("Invalid uuid")
    return s


def zstring(*steps: Step) -> Callable[[Any], str]:
    """`z.string()` followed by `steps` (`.trim()`, `.min()`, `.regex()`, …) in their zod order."""

    def check(v: Any) -> str:
        if not isinstance(v, str):
            raise invalid_type("string", v)
        for step in steps:
            v = step(v)
        return v

    return check


def zbool(v: Any) -> bool:
    if not isinstance(v, bool):
        raise invalid_type("boolean", v)
    return v


def zint(v: Any) -> int:
    """`z.number().int()`."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise invalid_type("number", v)
    if isinstance(v, float) and not v.is_integer():
        raise zod_issue("Expected integer, received float")
    return int(v)


def zenum(*values: str) -> Callable[[Any], str]:
    joined = " | ".join(f"'{v}'" for v in values)

    def check(v: Any) -> str:
        if not isinstance(v, str):
            raise zod_issue("Required" if v is UNDEFINED else f"Expected {joined}, received {_js_type(v)}")
        if v not in values:
            raise zod_issue(f"Invalid enum value. Expected {joined}, received '{v}'")
        return v

    return check


def _wrap(check: Callable[[Any], Any], optional: bool, nullable: bool, default: Any) -> Callable[[Any], Any]:
    def run(v: Any) -> Any:
        if v is UNDEFINED:
            if optional:  # `.optional()` (also what `.partial()` adds): a missing key stays missing
                return None
            if default is not _NO_DEFAULT:  # `.default(x)`
                v = copy.deepcopy(default)
        if v is None and nullable:
            return None
        return check(v)

    return run


def zod(
    check: Callable[[Any], Any], *, optional: bool = False, nullable: bool = False, default: Any = _NO_DEFAULT
) -> PlainValidator:
    """The validator for one scalar field: `check` plus `.optional()` / `.nullable()` / `.default()`."""
    return PlainValidator(_wrap(check, optional, nullable, default))


def zarray(max_items: int, *, optional: bool = False, default: Any = _NO_DEFAULT) -> BeforeValidator:
    """`z.array(item).max(n)` — put it on a `list[Annotated[T, zod(item)]]` so item issues carry their index.

    An optional array that is missing comes out as `[]`; tell it apart with `model_fields_set`.
    """

    def check(v: Any) -> list[Any]:
        if not isinstance(v, list):
            raise invalid_type("array", v)
        if len(v) > max_items:
            raise zod_issue(f"Array must contain at most {max_items} element(s)")
        return v

    run = _wrap(check, optional, False, default)
    return BeforeValidator(lambda v: [] if (r := run(v)) is None else r)


class ZodModel(BaseModel):
    """`z.object({...})`: unknown keys are dropped, a non-object body is "Expected object, received …"."""

    model_config = ConfigDict(validate_default=True, extra="ignore")

    @model_validator(mode="before")
    @classmethod
    def _an_object(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            raise invalid_type("object", data)
        return data

    def given(self) -> list[str]:
        """The JSON keys the caller sent, in schema order (zod's `Object.keys(parsed)` minus undefined values)."""
        return [name for name in type(self).model_fields if name in self.model_fields_set]


# ─── Inputs (packages/contracts/src/catalog.ts and schemas.ts) ─────────────────────────────────────────────────

SLUG_PATTERN = r"[a-z0-9][a-z0-9-]*"

_NAME = zstring(trim, min_len(1, "Enter a name."), max_len(100))
_DESCRIPTION = zstring(trim, min_len(1, "Describe what it does."), max_len(500))
_CATEGORY = zstring(trim, min_len(1), max_len(40))
_STAGE = zstring(trim, min_len(1), max_len(40))
_TOOL = zstring(trim, min_len(1), max_len(80))
_MODEL = zstring(trim, max_len(120))
_ROLE = zenum(*PROJECT_ROLES)
_INSTRUCTIONS = zstring(trim, min_len(1, "Write the instructions."), max_len(20_000))
_SLUG = zstring(trim, min_len(2), max_len(60), matches(SLUG_PATTERN, "Use lowercase letters, digits and hyphens."))

Tool = Annotated[str, zod(_TOOL)]


class PlatformAgentFields(ZodModel):
    name: Annotated[str, zod(_NAME)] = MISSING
    description: Annotated[str, zod(_DESCRIPTION)] = MISSING
    category: Annotated[str, zod(_CATEGORY, default="general")] = MISSING
    sdlcStage: Annotated[str, zod(_STAGE, default="implement")] = MISSING
    tools: Annotated[list[Tool], zarray(40, default=[])] = MISSING
    model: Annotated[str | None, zod(_MODEL, nullable=True, default=None)] = MISSING
    minProjectRole: Annotated[str | None, zod(_ROLE, nullable=True, default=None)] = MISSING
    instructions: Annotated[str, zod(_INSTRUCTIONS)] = MISSING


class CreatePlatformAgentInput(PlatformAgentFields):
    kind: Annotated[str, zod(zenum("agent", "skill"), default="agent")] = MISSING
    slug: Annotated[str, zod(_SLUG)] = MISSING


class UpdatePlatformAgentInput(ZodModel):
    """`PlatformAgentFieldsSchema.partial()`: a missing key leaves the field alone (its default does not apply)."""

    name: Annotated[str | None, zod(_NAME, optional=True)] = MISSING
    description: Annotated[str | None, zod(_DESCRIPTION, optional=True)] = MISSING
    category: Annotated[str | None, zod(_CATEGORY, optional=True)] = MISSING
    sdlcStage: Annotated[str | None, zod(_STAGE, optional=True)] = MISSING
    tools: Annotated[list[Tool], zarray(40, optional=True)] = MISSING
    model: Annotated[str | None, zod(_MODEL, optional=True, nullable=True)] = MISSING
    minProjectRole: Annotated[str | None, zod(_ROLE, optional=True, nullable=True)] = MISSING
    instructions: Annotated[str | None, zod(_INSTRUCTIONS, optional=True)] = MISSING


class ToggleAgentInput(ZodModel):
    enabled: Annotated[bool, zod(zbool)] = MISSING


# ─── Catalog reads ─────────────────────────────────────────────────────────────────────────────────────────────


def visible_agents(project_id: str) -> sa.ColumnElement[bool]:
    """Built-ins plus this project's own agents and skills (repo-discovered and platform-defined)."""
    return sa.or_(t.agents.c.project_id.is_(None), t.agents.c.project_id == project_id)


def agents_with_enabled(project_id: str) -> sa.Select[Any]:
    """Every agent column plus `enabled` (null when the project never toggled it), for this project."""
    joined = t.agents.outerjoin(
        t.project_agents,
        sa.and_(t.project_agents.c.agent_id == t.agents.c.id, t.project_agents.c.project_id == project_id),
    )
    return sa.select(t.agents, t.project_agents.c.enabled).select_from(joined)


def to_agent(access: ProjectAccess, agent: Any, enabled: bool | None) -> dict[str, Any]:
    """The contract `Agent` (camelCase) for an `agents` row."""
    return {
        "id": agent.id,
        "slug": agent.slug,
        "name": agent.name,
        "description": agent.description,
        "category": agent.category,
        "sdlcStage": agent.sdlc_stage,
        "executionTarget": agent.execution_target,
        "tools": list(agent.tools or []),
        # A catalog agent added after the project was created stays off until someone enables it.
        "enabled": bool(enabled) if enabled is not None else False,
        "source": agent.source,
        "kind": agent.kind,
        "branch": agent.branch,
        "requiredRole": agent.min_project_role,
        "usable": can_use_agent(access.actor, access.role, agent.min_project_role),
        "sourcePath": agent.source_path,
        "model": agent.model,
        "issues": agent.issues if agent.issues is not None else [],
    }


def to_agent_detail(access: ProjectAccess, agent: Any, enabled: bool | None) -> dict[str, Any]:
    return {**to_agent(access, agent, enabled), "instructions": agent.instructions}


async def find_agent(conn: AsyncConnection, access: ProjectAccess, slug: str) -> Any | None:
    """The agent visible to the project with this slug (a row of `agents_with_enabled`), or None."""
    return (
        await conn.execute(
            agents_with_enabled(access.project.id)
            .where(t.agents.c.slug == slug, visible_agents(access.project.id))
            .limit(1)
        )
    ).first()


async def list_agents(user: AuthUser, key: str) -> list[dict[str, Any]]:
    async with read() as conn:
        access = await load_project_access(conn, user, key)
        # Every agent is listed (restricted ones locked via `usable`) so people can see what exists even when they
        # may not use it.
        rows = (
            await conn.execute(
                agents_with_enabled(access.project.id)
                .where(visible_agents(access.project.id))
                .order_by(t.agents.c.category.asc(), t.agents.c.name.asc())
            )
        ).all()
    return [to_agent(access, r, r.enabled) for r in rows]


async def get_agent(user: AuthUser, key: str, slug: str) -> dict[str, Any]:
    """One agent with its full definition. Restricted agents are readable too ("visible, but can't use it")."""
    async with read() as conn:
        access = await load_project_access(conn, user, key)
        row = await find_agent(conn, access, slug)
    if row is None:
        raise not_found("Agent")
    return to_agent_detail(access, row, row.enabled)


def _node_list(spec: Any) -> list[Any]:
    nodes = spec.get("nodes") if isinstance(spec, dict) else None
    return nodes if isinstance(nodes, list) else []


def _node_data(node: Any) -> dict[str, Any]:
    data = node.get("data") if isinstance(node, dict) else None
    return data if isinstance(data, dict) else {}


async def steps_using(conn: AsyncConnection, project_id: str, slug: str) -> list[str]:
    """The workflow steps that bind `slug` as their agent or one of their skills: "Planning › Plan, Hotfix › Review"."""
    rows = (await conn.execute(sa.select(t.workflows).where(t.workflows.c.project_id == project_id))).all()
    out: list[str] = []
    for w in rows:
        for n in _node_list(w.spec):
            if not isinstance(n, dict) or n.get("kind") != "agent":
                continue
            data = _node_data(n)
            skills = data.get("skills")
            if data.get("agentId") == slug or (isinstance(skills, list) and slug in skills):
                out.append(f"{w.name} › {js_str(n.get('label', UNDEFINED))}")
    return out


# ─── Catalog writes ────────────────────────────────────────────────────────────────────────────────────────────


async def set_agent_enabled(caller: Caller, key: str, slug: str, enabled: bool) -> dict[str, Any]:
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "agent.configure")
        agent = await find_agent(conn, access, slug)
        if agent is None:
            raise not_found("Agent")
        assert_can_use_agent(access, agent.min_project_role)
        if not enabled:
            # Turning off an agent a workflow step still runs would silently break that workflow — make them remap.
            used_in = await steps_using(conn, access.project.id, slug)
            if used_in:
                raise conflict(
                    f"{agent.name} is mapped to {', '.join(used_in)}. Map those steps to another agent first."
                )
        stmt = pg_insert(t.project_agents).values(project_id=access.project.id, agent_id=agent.id, enabled=enabled)
        await conn.execute(
            stmt.on_conflict_do_update(
                index_elements=[t.project_agents.c.project_id, t.project_agents.c.agent_id],
                set_={"enabled": enabled, "updated_at": sa.func.now()},
            )
        )
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="agent.enabled" if enabled else "agent.disabled",
            resource_type="agent",
            resource_id=agent.id,
            data={"slug": slug},
            via=caller.via,
        )
        await publish(conn, project_changed(access.project.key, "agents", caller.user.id))
    return {"slug": slug, "enabled": enabled}


async def create_platform_agent(caller: Caller, key: str, raw: Any) -> dict[str, Any]:
    """Create a platform agent or skill in the project. It starts enabled."""
    data = parse(CreatePlatformAgentInput, raw)
    try:
        async with transaction() as conn:
            access = await load_project_access(conn, caller.user, key)
            assert_can(access, "agent.configure")
            clash = await find_agent(conn, access, data.slug)
            if clash is not None:
                where = {"builtin": "a built-in", "repo": "a repository"}.get(clash.source, "a platform")
                raise conflict(
                    f'"{data.slug}" is already used by {where} {clash.kind} ({clash.name}). Pick another slug.'
                )
            created = (
                await conn.execute(
                    t.agents.insert()
                    .values(
                        slug=data.slug,
                        source="platform",
                        kind=data.kind,
                        project_id=access.project.id,
                        branch=None,
                        min_project_role=data.minProjectRole,
                        name=data.name,
                        description=data.description,
                        category=data.category,
                        sdlc_stage=data.sdlcStage,
                        execution_target="local",
                        tools=list(dict.fromkeys(data.tools)),
                        instructions=data.instructions,
                        source_path=None,
                        model=data.model,
                        issues=[],
                    )
                    .returning(t.agents)
                )
            ).one()
            await conn.execute(
                t.project_agents.insert().values(project_id=access.project.id, agent_id=created.id, enabled=True)
            )
            await write_audit(
                conn,
                org_id=caller.user.org_id,
                project_id=access.project.id,
                actor_user_id=caller.user.id,
                action="skill.created" if data.kind == "skill" else "agent.created",
                resource_type="agent",
                resource_id=created.id,
                data={"slug": created.slug, "name": created.name},
                via=caller.via,
            )
            await publish(conn, project_changed(access.project.key, "agents", caller.user.id))
    except IntegrityError as err:
        if is_unique_violation(err):
            raise conflict(f'"{data.slug}" is already taken in this project.') from err
        raise
    return to_agent_detail(access, created, True)


async def _load_platform_agent(conn: AsyncConnection, access: ProjectAccess, slug: str) -> Any:
    row = await find_agent(conn, access, slug)
    if row is None:
        raise not_found("Agent")
    if row.source != "platform":
        if row.source == "builtin":
            raise bad_request(f"{row.name} is a built-in {row.kind} and can't be changed here.")
        raise bad_request(
            f"{row.name} comes from the repository ({row.source_path or 'its definition file'}) — edit it there."
        )
    return row


# Input field → agents column, in the order the TypeScript builds its update.
_UPDATABLE = (
    ("name", "name"),
    ("description", "description"),
    ("category", "category"),
    ("sdlcStage", "sdlc_stage"),
    ("model", "model"),
    ("minProjectRole", "min_project_role"),
    ("instructions", "instructions"),
)


async def update_platform_agent(caller: Caller, key: str, slug: str, raw: Any) -> dict[str, Any]:
    data = parse(UpdatePlatformAgentInput, raw)
    sent = data.model_fields_set
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "agent.configure")
        agent = await _load_platform_agent(conn, access, slug)
        assert_can_use_agent(access, agent.min_project_role)
        changes: dict[str, Any] = {column: getattr(data, field) for field, column in _UPDATABLE if field in sent}
        if "tools" in sent:
            changes["tools"] = list(dict.fromkeys(data.tools))
        if not changes:
            return to_agent_detail(access, agent, agent.enabled if agent.enabled is not None else True)

        updated = (
            await conn.execute(t.agents.update().where(t.agents.c.id == agent.id).values(**changes).returning(t.agents))
        ).one()
        # Workflow steps show the agent's name; keep it current.
        if "name" in sent and data.name != agent.name and agent.kind == "agent":
            flows = (
                await conn.execute(sa.select(t.workflows).where(t.workflows.c.project_id == access.project.id))
            ).all()
            for w in flows:
                spec = w.spec if isinstance(w.spec, dict) else {}
                nodes = _node_list(spec)
                if not any(_runs_agent(n, slug) for n in nodes):
                    continue
                renamed = [
                    {**n, "data": {**_node_data(n), "agentName": data.name}} if _runs_agent(n, slug) else n
                    for n in nodes
                ]
                await conn.execute(
                    t.workflows.update()
                    .where(t.workflows.c.id == w.id)
                    .values(spec={**spec, "nodes": renamed}, version=w.version + 1)
                )
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="skill.updated" if agent.kind == "skill" else "agent.updated",
            resource_type="agent",
            resource_id=agent.id,
            data={"slug": slug, "fields": data.given()},
            via=caller.via,
        )
        await publish(conn, project_changed(access.project.key, "agents", caller.user.id))
        row = await find_agent(conn, access, slug)
    enabled = row.enabled if row is not None and row.enabled is not None else True
    return to_agent_detail(access, updated, enabled)


def _runs_agent(node: Any, slug: str) -> bool:
    return isinstance(node, dict) and node.get("kind") == "agent" and _node_data(node).get("agentId") == slug


async def delete_platform_agent(caller: Caller, key: str, slug: str) -> dict[str, Any]:
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "agent.configure")
        agent = await _load_platform_agent(conn, access, slug)
        assert_can_use_agent(access, agent.min_project_role)
        used_in = await steps_using(conn, access.project.id, slug)
        if used_in:
            raise conflict(f"{agent.name} is used by {', '.join(used_in)}. Remove it from those steps first.")
        await conn.execute(t.agents.delete().where(t.agents.c.id == agent.id))
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="skill.deleted" if agent.kind == "skill" else "agent.deleted",
            resource_type="agent",
            resource_id=agent.id,
            data={"slug": slug, "name": agent.name},
            via=caller.via,
        )
        await publish(conn, project_changed(access.project.key, "agents", caller.user.id))
    return {"ok": True}
