"""Project workflows (port of apps/api/src/services/workflows.ts and stepSkills.ts).

List and read them, create new ones, edit a workflow's name/description/spec, pick the project default, delete one,
and map an agent, skills or a harness onto a step. Every saved spec passes validate_workflow_spec, and every
agent/skill it binds must be visible to the project, enabled in it and usable by the caller — the same rules the
step-mapping screen enforces. Every pinned harness must be one the project allows.

Specs are stored as the plain camelCase JSON the caller sent (plus the bindings resolved here), never re-serialized,
so unknown keys survive and no nulls are added.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any

import sqlalchemy as sa
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..access import ProjectAccess, assert_can, assert_can_use_agent, load_project_access
from ..audit import write_audit
from ..db import tables as t
from ..db.engine import read, transaction
from ..errors import bad_request, conflict, not_found
from ..events import project_changed, publish
from ..harnesses import harness_label, is_allowed, read_project_settings
from ..http import parse
from ..security import AuthUser, Caller
from ..spec.jscompat import UNDEFINED, js_str, js_truthy
from ..spec.models import parse_spec
from ..spec.validate import validate_workflow_spec
from .agents import (
    MISSING,
    ZodModel,
    agents_with_enabled,
    lower,
    matches,
    max_len,
    min_len,
    trim,
    visible_agents,
    zarray,
    zbool,
    zint,
    zod,
    zod_issue,
    zstring,
)

# Runs in these states still use their workflow; it can't be deleted under them.
ACTIVE_RUN_STATUSES = ("requested", "queued", "running", "awaiting_approval")

# ─── Inputs (packages/contracts/src/catalog.ts, schemas.ts, sessions.ts, engines.ts) ───────────────────────────


def _spec_shape(v: Any) -> dict[str, Any]:
    """`WorkflowSpecInputSchema` — a shallow shape check only; validate_workflow_spec does the rest."""
    version = v.get("specVersion") if isinstance(v, dict) else None
    if (
        isinstance(v, dict)
        and isinstance(version, (int, float))
        and not isinstance(version, bool)
        and version == 1
        and isinstance(v.get("nodes"), list)
        and isinstance(v.get("edges"), list)
    ):
        return v
    raise zod_issue("Not a workflow spec.")


_WF_NAME = zstring(trim, min_len(1, "Enter a workflow name."), max_len(100))
_WF_RENAME = zstring(trim, min_len(1), max_len(100))
_WF_DESCRIPTION = zstring(trim, max_len(2000))
_STEP_SLUG = zstring(matches(r"[a-z0-9-]+"), max_len(200))
# HarnessIdSchema: trimmed and lowercased before the pattern check.
_HARNESS_ID = zstring(
    trim, lower, matches(r"[a-z0-9][a-z0-9-]{0,39}", "A harness id is lowercase letters, digits and dashes.")
)


class CreateWorkflowInput(ZodModel):
    name: Annotated[str, zod(_WF_NAME)] = MISSING
    description: Annotated[str, zod(_WF_DESCRIPTION, default="")] = MISSING
    spec: Annotated[dict[str, Any], zod(_spec_shape)] = MISSING
    setAsDefault: Annotated[bool, zod(zbool, default=False)] = MISSING


class UpdateWorkflowInput(ZodModel):
    # The version the edit is based on; a stale version is rejected with 409.
    version: Annotated[int, zod(zint)] = MISSING
    name: Annotated[str | None, zod(_WF_RENAME, optional=True)] = MISSING
    description: Annotated[str | None, zod(_WF_DESCRIPTION, optional=True)] = MISSING
    spec: Annotated[dict[str, Any] | None, zod(_spec_shape, optional=True)] = MISSING


class SetStepAgentInput(ZodModel):
    agentSlug: Annotated[str | None, zod(_STEP_SLUG, nullable=True)] = MISSING


class SetStepSkillsInput(ZodModel):
    skills: Annotated[list[Annotated[str, zod(_STEP_SLUG)]], zarray(20)] = MISSING


class SetStepHarnessInput(ZodModel):
    harness: Annotated[str | None, zod(_HARNESS_ID, nullable=True)] = MISSING


# ─── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────


def _summary(w: Any) -> dict[str, Any]:
    return {"id": w.id, "name": w.name, "description": w.description, "isDefault": w.is_default, "version": w.version}


def _detail(w: Any) -> dict[str, Any]:
    return {**_summary(w), "spec": w.spec}


def _prop(obj: Any, key: str) -> Any:
    """`obj.key` with JS semantics: a missing key (or a non-object) reads as UNDEFINED."""
    return obj.get(key, UNDEFINED) if isinstance(obj, dict) else UNDEFINED


def _data(node: Any) -> dict[str, Any]:
    data = _prop(node, "data")
    return data if isinstance(data, dict) else {}


def _nodes(spec: Any) -> list[Any]:
    nodes = _prop(spec, "nodes")
    return nodes if isinstance(nodes, list) else []


def _list(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _with_node_data(spec: dict[str, Any], node_id: str, change: Callable[[dict[str, Any]], dict[str, Any]]) -> dict:
    """The spec with `change` applied to the data of the node(s) with this id."""
    nodes = [{**n, "data": change(dict(_data(n)))} if _prop(n, "id") == node_id else n for n in _nodes(spec)]
    return {**spec, "nodes": nodes}


def _not_allowed(harness: str) -> str:
    return f"{harness_label(harness)} is not allowed in this project. Allow it in the project's harness settings first."


def _allowed_harnesses(access: ProjectAccess) -> list[str]:
    _default, allowed = read_project_settings(access.project.settings)
    return allowed


async def _load_workflow(conn: AsyncConnection, access: ProjectAccess, workflow_id: str) -> Any:
    w = (
        await conn.execute(
            sa.select(t.workflows)
            .where(t.workflows.c.id == workflow_id, t.workflows.c.project_id == access.project.id)
            .limit(1)
        )
    ).first()
    if w is None:
        raise not_found("Workflow")
    return w


def _find_step(w: Any, node_id: str) -> dict[str, Any]:
    node = next((n for n in _nodes(w.spec) if _prop(n, "id") == node_id), None)
    if node is None:
        raise not_found("Workflow step")
    return node


async def _bound_agents(conn: AsyncConnection, access: ProjectAccess, slugs: list[str]) -> dict[str, Any]:
    """slug → row of `agents_with_enabled`, for the visible agents and skills with these slugs."""
    if not slugs:
        return {}
    rows = (
        await conn.execute(
            agents_with_enabled(access.project.id).where(t.agents.c.slug.in_(slugs), visible_agents(access.project.id))
        )
    ).all()
    return {r.slug: r for r in rows}


async def _save_step_change(
    conn: AsyncConnection, caller: Caller, access: ProjectAccess, w: Any, spec: dict, action: str, data: dict
) -> int:
    """Write a one-step change: the new spec, a version bump, the audit entry and the live event."""
    version = int(w.version) + 1
    await conn.execute(t.workflows.update().where(t.workflows.c.id == w.id).values(spec=spec, version=version))
    await write_audit(
        conn,
        org_id=caller.user.org_id,
        project_id=access.project.id,
        actor_user_id=caller.user.id,
        action=action,
        resource_type="workflow",
        resource_id=w.id,
        data=data,
        via=caller.via,
    )
    await publish(conn, project_changed(access.project.key, "workflows", caller.user.id))
    return version


# ─── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────


async def list_workflows(user: AuthUser, key: str) -> list[dict[str, Any]]:
    async with read() as conn:
        access = await load_project_access(conn, user, key)
        rows = (
            await conn.execute(
                sa.select(t.workflows)
                .where(t.workflows.c.project_id == access.project.id)
                .order_by(t.workflows.c.is_default.desc(), t.workflows.c.name.asc())
            )
        ).all()
    return [_summary(w) for w in rows]


async def get_workflow(user: AuthUser, key: str, workflow_id: str) -> dict[str, Any]:
    async with read() as conn:
        access = await load_project_access(conn, user, key)
        w = await _load_workflow(conn, access, workflow_id)
    return _detail(w)


# ─── Validation ────────────────────────────────────────────────────────────────────────────────────────────────


async def resolve_bindings(conn: AsyncConnection, access: ProjectAccess, spec: dict[str, Any]) -> dict[str, Any]:
    """Check every agent and skill the spec binds and every harness it pins, and stamp agent steps with the catalog
    name. Raises 400/403/404/409 with a message naming the step, so the chat assistant (or the form) can tell the
    user what to fix."""
    slugs: dict[str, None] = {}
    for n in _nodes(spec):
        if _prop(n, "kind") != "agent":
            continue
        data = _data(n)
        agent_id = data.get("agentId")
        if js_truthy(agent_id) and isinstance(agent_id, str):
            slugs[agent_id] = None
        for s in _list(data.get("skills")):
            if isinstance(s, str):
                slugs[s] = None
    by_slug = await _bound_agents(conn, access, list(slugs))
    allowed = _allowed_harnesses(access)

    def check(slug: Any, kind: str, step: str) -> Any:
        row = by_slug.get(slug) if isinstance(slug, str) else None
        if row is None:
            raise not_found(f'{"Skill" if kind == "skill" else "Agent"} "{js_str(slug)}" (step "{step}")')
        if row.kind != kind:
            raise bad_request(
                f'"{slug}" on step "{step}" is {"a skill" if row.kind == "skill" else "an agent"}, '
                f"not {'a skill' if kind == 'skill' else 'an agent'}."
            )
        assert_can_use_agent(access, row.min_project_role)
        if not row.enabled:
            raise conflict(f'{row.name} (step "{step}") is not enabled in this project. Enable it first.')
        return row

    nodes: list[Any] = []
    for n in _nodes(spec):
        if _prop(n, "kind") != "agent":
            nodes.append(n)
            continue
        label = js_str(_prop(n, "label"))
        data = dict(_data(n))
        if js_truthy(data.get("agentId")):
            data["agentName"] = check(data["agentId"], "agent", label).name
        else:
            data.pop("agentName", None)
        for s in _list(data.get("skills")):
            check(s, "skill", label)
        harness = data.get("harness")
        if isinstance(harness, str) and harness and not is_allowed(harness, allowed):
            raise conflict(f'Step "{label}": {_not_allowed(harness)}')
        nodes.append({**n, "data": data})
    return {**spec, "nodes": nodes}


def assert_valid(spec: dict[str, Any]) -> None:
    errors = validate_workflow_spec(spec).errors
    if errors:
        raise bad_request(" ".join(errors), errors)
    # The engine loads saved specs with parse_spec; refuse one it could not run (a step kind it does not know, a
    # non-string id, …). validate_workflow_spec accepts the loose shapes the TypeScript accepted.
    try:
        parse_spec(spec)
    except ValidationError as e:
        issues = e.errors(include_url=False, include_context=False)
        first = issues[0]
        where = ".".join(["spec", *(str(p) for p in first["loc"])])
        raise bad_request(
            f"{where}: {first['msg']}", [{"path": ["spec", *first["loc"]], "message": i["msg"]} for i in issues]
        ) from e


async def assert_name_free(conn: AsyncConnection, project_id: str, name: str, except_id: str | None = None) -> None:
    where = [t.workflows.c.project_id == project_id, sa.func.lower(t.workflows.c.name) == sa.func.lower(name)]
    if except_id:
        where.append(t.workflows.c.id != except_id)
    dupe = (await conn.execute(sa.select(t.workflows.c.id).where(*where).limit(1))).first()
    if dupe is not None:
        raise conflict(f'This project already has a workflow called "{name}".')


# ─── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────


async def create_workflow(caller: Caller, key: str, raw: Any) -> dict[str, Any]:
    data = parse(CreateWorkflowInput, raw)
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "workflow.edit")
        spec = await resolve_bindings(conn, access, {**data.spec, "name": data.name, "description": data.description})
        assert_valid(spec)
        await assert_name_free(conn, access.project.id, data.name)

        count = (
            await conn.execute(
                sa.select(sa.func.count()).select_from(t.workflows).where(t.workflows.c.project_id == access.project.id)
            )
        ).scalar_one()
        # The first workflow of a project becomes its default either way.
        is_default = data.setAsDefault or count == 0
        if is_default:
            await conn.execute(
                t.workflows.update().where(t.workflows.c.project_id == access.project.id).values(is_default=False)
            )
        created = (
            await conn.execute(
                t.workflows.insert()
                .values(
                    project_id=access.project.id,
                    name=data.name,
                    description=data.description,
                    is_default=is_default,
                    spec=spec,
                    version=1,
                )
                .returning(t.workflows)
            )
        ).one()
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="workflow.created",
            resource_type="workflow",
            resource_id=created.id,
            data={"workflow": created.name, "steps": len(_nodes(spec)), "isDefault": is_default},
            via=caller.via,
        )
        await publish(conn, project_changed(access.project.key, "workflows", caller.user.id))
    return _detail(created)


async def update_workflow(caller: Caller, key: str, workflow_id: str, raw: Any) -> dict[str, Any]:
    data = parse(UpdateWorkflowInput, raw)
    spec_sent = "spec" in data.model_fields_set
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "workflow.edit")
        w = await _load_workflow(conn, access, workflow_id)
        if data.version != w.version:
            raise conflict(f'"{w.name}" changed since you loaded it (now version {w.version}). Reload and try again.')
        name = data.name if data.name is not None else w.name
        description = data.description if data.description is not None else w.description
        if name != w.name:
            await assert_name_free(conn, access.project.id, name, w.id)
        base = data.spec if spec_sent and data.spec is not None else w.spec
        spec = await resolve_bindings(conn, access, {**base, "name": name, "description": description})
        assert_valid(spec)

        updated = (
            await conn.execute(
                t.workflows.update()
                .where(t.workflows.c.id == w.id, t.workflows.c.version == w.version)
                .values(name=name, description=description, spec=spec, version=w.version + 1)
                .returning(t.workflows)
            )
        ).first()
        if updated is None:
            raise conflict(f'"{w.name}" changed while you were editing it. Reload and try again.')
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="workflow.updated",
            resource_type="workflow",
            resource_id=w.id,
            data={
                "workflow": name,
                "from": w.name if w.name != name else None,
                "specChanged": spec_sent,
                "version": updated.version,
            },
            via=caller.via,
        )
        await publish(conn, project_changed(access.project.key, "workflows", caller.user.id))
    return _detail(updated)


async def set_default_workflow(caller: Caller, key: str, workflow_id: str) -> dict[str, Any]:
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "workflow.edit")
        w = await _load_workflow(conn, access, workflow_id)
        if w.is_default:
            return _summary(w)
        await conn.execute(
            t.workflows.update().where(t.workflows.c.project_id == access.project.id).values(is_default=False)
        )
        updated = (
            await conn.execute(
                t.workflows.update().where(t.workflows.c.id == w.id).values(is_default=True).returning(t.workflows)
            )
        ).one()
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="workflow.default_set",
            resource_type="workflow",
            resource_id=w.id,
            data={"workflow": w.name},
            via=caller.via,
        )
        await publish(conn, project_changed(access.project.key, "workflows", caller.user.id))
    return _summary(updated)


async def delete_workflow(caller: Caller, key: str, workflow_id: str) -> dict[str, Any]:
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "workflow.edit")
        w = await _load_workflow(conn, access, workflow_id)
        if w.is_default:
            raise conflict(f'"{w.name}" is the project default. Make another workflow the default first.')
        active = (
            await conn.execute(
                sa.select(sa.func.count())
                .select_from(t.runs)
                .where(t.runs.c.workflow_id == w.id, t.runs.c.status.in_(ACTIVE_RUN_STATUSES))
            )
        ).scalar_one()
        if active > 0:
            raise conflict(f'"{w.name}" has {active} run(s) in progress. Wait for them or cancel them first.')
        await conn.execute(t.workflows.delete().where(t.workflows.c.id == w.id))
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="workflow.deleted",
            resource_type="workflow",
            resource_id=w.id,
            data={"workflow": w.name, "version": w.version},
            via=caller.via,
        )
        await publish(conn, project_changed(access.project.key, "workflows", caller.user.id))
    return {"ok": True}


# ─── One step: its agent, skills and harness ───────────────────────────────────────────────────────────────────


async def set_step_agent(caller: Caller, key: str, workflow_id: str, node_id: str, raw: Any) -> dict[str, Any]:
    """Map an agent onto one agent step of a project workflow (null unbinds it). The agent must be visible to the
    project, enabled in it and usable by the caller; the workflow's version bumps so clients can tell it changed."""
    agent_slug = parse(SetStepAgentInput, raw).agentSlug
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "workflow.edit")
        w = await _load_workflow(conn, access, workflow_id)
        node = _find_step(w, node_id)
        label, kind = js_str(_prop(node, "label")), js_str(_prop(node, "kind"))
        if kind != "agent":
            raise bad_request(f'"{label}" is a {kind} step — only agent steps take an agent.')

        agent_name: str | None = None
        agent_row_id: str | None = None
        if agent_slug:
            row = (await _bound_agents(conn, access, [agent_slug])).get(agent_slug)
            if row is None:
                raise not_found("Agent")
            assert_can_use_agent(access, row.min_project_role)
            if not row.enabled:
                raise conflict(f"{row.name} is not enabled in this project. Enable it on the Agents page first.")
            agent_name = row.name
            agent_row_id = row.id

        previous = _data(node).get("agentId")

        def change(data: dict[str, Any]) -> dict[str, Any]:
            data.pop("agentId", None)
            data.pop("agentName", None)
            if not agent_slug:
                return data
            return {**data, "agentId": agent_slug, "agentName": agent_name if agent_name is not None else agent_slug}

        version = await _save_step_change(
            conn,
            caller,
            access,
            w,
            _with_node_data(w.spec, node_id, change),
            "workflow.step_mapped",
            {
                "workflow": w.name,
                "step": node.get("label"),
                "from": previous if isinstance(previous, str) else None,
                "to": agent_slug,
                "agentId": agent_row_id,
            },
        )
    return {"workflowId": w.id, "nodeId": node_id, "agentSlug": agent_slug, "agentName": agent_name, "version": version}


async def set_step_skills(caller: Caller, key: str, workflow_id: str, node_id: str, raw: Any) -> dict[str, Any]:
    """The catalog skills an agent step may use (replaces the list). Each must be an enabled skill the caller may
    use. When a run starts, the harness gets them materialized (e.g. `.claude/skills/` for Claude Code)."""
    data_in = parse(SetStepSkillsInput, raw)
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "workflow.edit")
        w = await _load_workflow(conn, access, workflow_id)
        node = _find_step(w, node_id)
        label, kind = js_str(_prop(node, "label")), js_str(_prop(node, "kind"))
        if kind != "agent":
            raise bad_request(f'"{label}" is a {kind} step — only agent steps use skills.')

        slugs = list(dict.fromkeys(data_in.skills))
        by_slug = await _bound_agents(conn, access, slugs)
        skills: list[dict[str, str]] = []
        for slug in slugs:
            row = by_slug.get(slug)
            if row is None:
                raise not_found(f"Skill {slug}")
            if row.kind != "skill":
                raise bad_request(f"{row.name} is an agent, not a skill — map it as the step's agent instead.")
            assert_can_use_agent(access, row.min_project_role)
            if not row.enabled:
                raise conflict(f"{row.name} is not enabled in this project. Enable it on the Skills page first.")
            skills.append({"slug": slug, "name": row.name})

        previous = _list(_data(node).get("skills"))

        def change(data: dict[str, Any]) -> dict[str, Any]:
            data.pop("skills", None)
            return {**data, "skills": slugs} if slugs else data

        version = await _save_step_change(
            conn,
            caller,
            access,
            w,
            _with_node_data(w.spec, node_id, change),
            "workflow.step_skills",
            {"workflow": w.name, "step": node.get("label"), "from": previous, "to": slugs},
        )
    return {"workflowId": w.id, "nodeId": node_id, "skills": skills, "version": version}


async def set_step_harness(caller: Caller, key: str, workflow_id: str, node_id: str, raw: Any) -> dict[str, Any]:
    """Pin an agent step to a harness (null: the harness the run starts with). The project must allow it."""
    harness = parse(SetStepHarnessInput, raw).harness
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        assert_can(access, "workflow.edit")
        w = await _load_workflow(conn, access, workflow_id)
        node = _find_step(w, node_id)
        label, kind = js_str(_prop(node, "label")), js_str(_prop(node, "kind"))
        if kind != "agent":
            raise bad_request(f'"{label}" is a {kind} step — only agent steps run in a harness.')
        if harness is not None and not is_allowed(harness, _allowed_harnesses(access)):
            raise conflict(_not_allowed(harness))

        previous = _data(node).get("harness")

        def change(data: dict[str, Any]) -> dict[str, Any]:
            data.pop("harness", None)
            return {**data, "harness": harness} if harness else data

        version = await _save_step_change(
            conn,
            caller,
            access,
            w,
            _with_node_data(w.spec, node_id, change),
            "workflow.step_harness",
            {
                "workflow": w.name,
                "step": node.get("label"),
                "from": previous if isinstance(previous, str) else None,
                "to": harness,
            },
        )
    return {"workflowId": w.id, "nodeId": node_id, "harness": harness, "version": version}
