"""The catalog HTTP API against the dev database: same paths, status codes and messages as apps/api's catalogRoutes."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
import sqlalchemy as sa

from app.db import tables as t
from app.db.engine import read, transaction

from .conftest import Api, Cleanup

pytestmark = pytest.mark.db

PAY = "/api/v1/projects/PAY"
NOT_ALLOWED = "is not allowed in this project. Allow it in the project's harness settings first."

AGENT_KEYS = {
    "id",
    "slug",
    "name",
    "description",
    "category",
    "sdlcStage",
    "executionTarget",
    "tools",
    "enabled",
    "source",
    "kind",
    "branch",
    "requiredRole",
    "usable",
    "sourcePath",
    "model",
    "issues",
}


def unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def make_spec(agent: str | None = "planner", **agent_data: Any) -> dict[str, Any]:
    plan_data: dict[str, Any] = {"agentId": agent} if agent else {}
    return {
        "specVersion": 1,
        "name": "ignored",
        "description": "ignored",
        "pattern": "sequential",
        "nodes": [
            {"id": "start", "kind": "trigger", "label": "Start", "data": {"triggerType": "manual"}},
            {"id": "plan", "kind": "agent", "label": "Plan", "data": {**plan_data, **agent_data}},
            {"id": "ok", "kind": "approval", "label": "OK?", "data": {"question": "Good?"}},
            {"id": "done", "kind": "end", "label": "Done", "data": {}, "position": {"x": 1, "y": 2}},
        ],
        "edges": [
            {"source": "start", "target": "plan"},
            {"source": "plan", "target": "ok"},
            {"source": "ok", "target": "done"},
        ],
        "budget": {"maxSteps": 50, "timeoutMs": 300000, "maxTokens": 0},
        "x-kept": {"unknown": True},
    }


async def create_workflow(api: Api, cleanup: Cleanup, spec: dict[str, Any] | None = None, **extra: Any) -> dict:
    name = extra.pop("name", None) or unique("Catalog test")
    res = await api.post(f"{PAY}/workflows", {"name": name, "spec": spec or make_spec(), **extra})
    assert res.status_code == 201, res.text
    body = res.json()
    cleanup.workflows.append(body["id"])
    return body


async def create_agent(api: Api, cleanup: Cleanup, kind: str = "agent", **fields: Any) -> dict:
    body = {
        "slug": unique(f"t-{kind}"),
        "kind": kind,
        "name": unique(f"Test {kind}"),
        "description": "Made by the catalog tests.",
        "instructions": "Do the thing.",
        **fields,
    }
    res = await api.post(f"{PAY}/agents", body)
    assert res.status_code == 201, res.text
    created = res.json()
    cleanup.agents.append(created["id"])
    return created


def error(res: Any, status: int) -> str:
    assert res.status_code == status, res.text
    message: str = res.json()["message"]
    return message


async def default_workflow_id(key: str = "PAY") -> str:
    async with read() as conn:
        return (
            await conn.execute(
                sa.select(t.workflows.c.id)
                .join(t.projects, t.projects.c.id == t.workflows.c.project_id)
                .where(t.projects.c.key == key, t.workflows.c.is_default.is_(True))
            )
        ).scalar_one()


# ─── Gateway auth ──────────────────────────────────────────────────────────────────────────────────────────────


async def test_requires_the_internal_token(api: Api) -> None:
    res = await api.http.get(f"{PAY}/agents", headers={"x-sdlc-user-id": api.users["lead"]})
    assert res.status_code == 401


# ─── Agents: reads ─────────────────────────────────────────────────────────────────────────────────────────────


async def test_list_and_get_agents(api: Api) -> None:
    res = await api.get(f"{PAY}/agents", as_="dev1")
    assert res.status_code == 200
    agents = {a["slug"]: a for a in res.json()}
    planner = agents["planner"]
    assert set(planner) == AGENT_KEYS
    assert planner["source"] == "builtin" and planner["kind"] == "agent" and planner["enabled"] is True
    # Wayfinder needs a lead: listed for a developer, but locked.
    assert agents["wayfinder"]["requiredRole"] == "lead"
    assert agents["wayfinder"]["usable"] is False
    lead_view = {a["slug"]: a for a in (await api.get(f"{PAY}/agents", as_="lead")).json()}
    assert lead_view["wayfinder"]["usable"] is True

    detail = (await api.get(f"{PAY}/agents/planner", as_="viewer")).json()
    assert set(detail) == AGENT_KEYS | {"instructions"} and detail["instructions"]

    assert error(await api.get(f"{PAY}/agents/no-such-agent"), 404) == "Agent not found."
    assert error(await api.get("/api/v1/projects/ONB/agents", as_="dev1"), 404) == "Project not found."
    long_slug = "a" * 101
    assert (
        error(await api.get(f"{PAY}/agents/{long_slug}"), 400) == "slug: String must contain at most 100 character(s)"
    )


# ─── Workflows: reads ──────────────────────────────────────────────────────────────────────────────────────────


async def test_list_and_get_workflows(api: Api) -> None:
    res = await api.get(f"{PAY}/workflows", as_="viewer")
    assert res.status_code == 200
    flows = res.json()
    assert flows and flows[0]["isDefault"] is True  # the default sorts first
    assert set(flows[0]) == {"id", "name", "description", "isDefault", "version"}

    detail = (await api.get(f"{PAY}/workflows/{flows[0]['id']}", as_="viewer")).json()
    assert detail["spec"]["specVersion"] == 1 and set(detail) == set(flows[0]) | {"spec"}

    assert error(await api.get(f"{PAY}/workflows/not-a-uuid"), 400) == "id: Invalid uuid"
    assert error(await api.get(f"{PAY}/workflows/{uuid.uuid4()}"), 404) == "Workflow not found."
    # A workflow of another project is not found through this one.
    assert error(await api.get(f"/api/v1/projects/ONB/workflows/{flows[0]['id']}"), 404) == "Workflow not found."


# ─── Workflows: create ─────────────────────────────────────────────────────────────────────────────────────────


async def test_create_workflow(api: Api, cleanup: Cleanup) -> None:
    name = unique("Catalog create")
    created = await create_workflow(api, cleanup, name=f"  {name}  ", description=" About it ")
    assert created["name"] == name and created["description"] == "About it"
    assert created["version"] == 1 and created["isDefault"] is False
    spec = created["spec"]
    # The name/description are stamped into the spec, agent steps get the catalog name, unknown keys survive.
    assert spec["name"] == name and spec["description"] == "About it"
    assert spec["nodes"][1]["data"] == {"agentId": "planner", "agentName": "Planner"}
    assert spec["nodes"][3]["position"] == {"x": 1, "y": 2} and spec["x-kept"] == {"unknown": True}
    assert "harness" not in spec["nodes"][1]["data"]

    listed = {w["id"] for w in (await api.get(f"{PAY}/workflows")).json()}
    assert created["id"] in listed

    # Names are unique per project, ignoring case.
    res = await api.post(f"{PAY}/workflows", {"name": name.upper(), "spec": make_spec()})
    assert error(res, 409) == f'This project already has a workflow called "{name.upper()}".'


async def test_create_workflow_rejects_bad_input(api: Api, cleanup: Cleanup) -> None:
    spec = make_spec()
    assert error(await api.post(f"{PAY}/workflows", {"spec": spec}), 400) == "name: Required"
    assert (
        error(await api.post(f"{PAY}/workflows", {"name": "  ", "spec": spec}), 400) == "name: Enter a workflow name."
    )
    assert error(await api.post(f"{PAY}/workflows", {"name": "x"}), 400) == "spec: Not a workflow spec."
    bad_version = {**spec, "specVersion": 2}
    assert error(await api.post(f"{PAY}/workflows", {"name": "x", "spec": bad_version}), 400) == (
        "spec: Not a workflow spec."
    )
    flag = {"name": "x", "spec": spec, "setAsDefault": "yes"}
    assert error(await api.post(f"{PAY}/workflows", flag), 400) == "setAsDefault: Expected boolean, received string"
    assert error(await api.post(f"{PAY}/workflows", [1, 2]), 400) == "Expected object, received array"

    # Structural validation (validate_workflow_spec), all messages joined.
    no_end = make_spec()
    no_end["nodes"] = no_end["nodes"][:3]
    no_end["edges"] = no_end["edges"][:2]
    res = await api.post(f"{PAY}/workflows", {"name": unique("No end"), "spec": no_end})
    assert error(res, 400) == "A workflow needs an end step."
    assert res.json()["details"] == ["A workflow needs an end step."]

    # Bindings.
    res = await api.post(f"{PAY}/workflows", {"name": unique("Unknown"), "spec": make_spec("no-such-agent")})
    assert error(res, 404) == 'Agent "no-such-agent" (step "Plan") not found.'
    skill = await create_agent(api, cleanup, kind="skill")
    res = await api.post(f"{PAY}/workflows", {"name": unique("Skill as agent"), "spec": make_spec(skill["slug"])})
    assert error(res, 400) == f'"{skill["slug"]}" on step "Plan" is a skill, not an agent.'
    res = await api.post(f"{PAY}/workflows", {"name": unique("Agent as skill"), "spec": make_spec(skills=["planner"])})
    assert error(res, 400) == '"planner" on step "Plan" is an agent, not a skill.'
    off = await create_agent(api, cleanup)
    assert (await api.put(f"{PAY}/agents/{off['slug']}", {"enabled": False})).status_code == 200
    res = await api.post(f"{PAY}/workflows", {"name": unique("Disabled"), "spec": make_spec(off["slug"])})
    assert error(res, 409) == f'{off["name"]} (step "Plan") is not enabled in this project. Enable it first.'
    # PAY allows Copilot and Claude Code only.
    res = await api.post(f"{PAY}/workflows", {"name": unique("Codex"), "spec": make_spec(harness="codex")})
    assert error(res, 409) == f'Step "Plan": Codex {NOT_ALLOWED}'

    # Permissions.
    res = await api.post(f"{PAY}/workflows", {"name": unique("Viewer"), "spec": make_spec()}, as_="viewer")
    assert error(res, 403) == "You do not have permission to do that."
    res = await api.post("/api/v1/projects/ONB/workflows", {"name": unique("Outsider"), "spec": spec}, as_="dev1")
    assert error(res, 404) == "Project not found."


async def test_create_workflow_with_an_allowed_harness(api: Api, cleanup: Cleanup) -> None:
    created = await create_workflow(api, cleanup, make_spec(harness="claude-code"))
    assert created["spec"]["nodes"][1]["data"]["harness"] == "claude-code"


# ─── Workflows: update, default, delete ────────────────────────────────────────────────────────────────────────


async def test_update_workflow(api: Api, cleanup: Cleanup) -> None:
    created = await create_workflow(api, cleanup)
    other = await create_workflow(api, cleanup)
    path = f"{PAY}/workflows/{created['id']}"

    assert error(await api.patch(path, {"name": "x"}), 400) == "version: Required"
    res = await api.patch(path, {"version": 7, "name": "x"})
    assert error(res, 409) == f'"{created["name"]}" changed since you loaded it (now version 1). Reload and try again.'
    res = await api.patch(path, {"version": 1, "name": other["name"]})
    assert error(res, 409) == f'This project already has a workflow called "{other["name"]}".'

    renamed = unique("Renamed")
    spec = make_spec("implementer")
    res = await api.patch(path, {"version": 1, "name": renamed, "spec": spec})
    assert res.status_code == 200, res.text
    updated = res.json()
    assert updated["version"] == 2 and updated["name"] == renamed
    assert updated["spec"]["name"] == renamed
    assert updated["spec"]["nodes"][1]["data"] == {"agentId": "implementer", "agentName": "Implementer"}

    # Description only: the stored spec is kept, re-stamped.
    res = await api.patch(path, {"version": 2, "description": "Now described"})
    assert res.status_code == 200 and res.json()["spec"]["description"] == "Now described"
    assert res.json()["version"] == 3

    res = await api.patch(path, {"version": 3, "spec": make_spec(harness="codex")})
    assert error(res, 409) == f'Step "Plan": Codex {NOT_ALLOWED}'
    assert error(await api.patch(path, {"version": 3, "name": "x"}, as_="dev1"), 403)


async def test_set_default_and_delete_guards(api: Api, cleanup: Cleanup) -> None:
    original = await default_workflow_id()

    async def restore_default() -> None:
        async with transaction() as conn:
            project_id = (await conn.execute(sa.select(t.projects.c.id).where(t.projects.c.key == "PAY"))).scalar_one()
            await conn.execute(
                t.workflows.update()
                .where(t.workflows.c.project_id == project_id, t.workflows.c.id != original)
                .values(is_default=False)
            )
            await conn.execute(t.workflows.update().where(t.workflows.c.id == original).values(is_default=True))

    cleanup.finalizers.append(restore_default)
    created = await create_workflow(api, cleanup)
    path = f"{PAY}/workflows/{created['id']}"

    res = await api.post(f"{path}/default")
    assert res.status_code == 200, res.text
    assert res.json() == {**{k: created[k] for k in ("id", "name", "description", "version")}, "isDefault": True}
    assert await default_workflow_id() == created["id"]
    # Setting it again is a no-op.
    assert (await api.post(f"{path}/default")).json()["isDefault"] is True
    assert (
        error(await api.delete(path), 409)
        == f'"{created["name"]}" is the project default. Make another workflow the default first.'
    )

    assert (await api.post(f"{PAY}/workflows/{original}/default")).status_code == 200
    assert await default_workflow_id() == original

    # A run in progress blocks the delete.
    async with transaction() as conn:
        project = (await conn.execute(sa.select(t.projects).where(t.projects.c.key == "PAY"))).one()
        run_id = (
            await conn.execute(
                t.runs.insert()
                .values(
                    org_id=project.org_id,
                    project_id=project.id,
                    origin="web",
                    driver="extension",
                    client_run_id=unique("catalog-test-run"),
                    workflow_name=created["name"],
                    workflow_id=created["id"],
                    status="running",
                    started_at=datetime.now(UTC),
                    tokens_in=0,
                    tokens_out=0,
                    changed_files=[],
                )
                .returning(t.runs.c.id)
            )
        ).scalar_one()
    cleanup.runs.append(run_id)
    res = await api.delete(path)
    assert error(res, 409) == f'"{created["name"]}" has 1 run(s) in progress. Wait for them or cancel them first.'
    async with transaction() as conn:
        await conn.execute(t.runs.update().where(t.runs.c.id == run_id).values(status="completed"))

    assert error(await api.delete(path, as_="viewer"), 403)
    res = await api.delete(path)
    assert res.status_code == 200 and res.json() == {"ok": True}
    assert error(await api.get(path), 404) == "Workflow not found."


async def test_create_as_default(api: Api, cleanup: Cleanup) -> None:
    original = await default_workflow_id()

    async def restore_default() -> None:
        async with transaction() as conn:
            await conn.execute(
                t.workflows.update().where(t.workflows.c.id.in_(cleanup.workflows)).values(is_default=False)
            )
            await conn.execute(t.workflows.update().where(t.workflows.c.id == original).values(is_default=True))

    cleanup.finalizers.append(restore_default)
    created = await create_workflow(api, cleanup, setAsDefault=True)
    assert created["isDefault"] is True
    assert await default_workflow_id() == created["id"]


# ─── One step: agent, skills, harness ──────────────────────────────────────────────────────────────────────────


async def test_set_step_agent(api: Api, cleanup: Cleanup) -> None:
    created = await create_workflow(api, cleanup)
    base = f"{PAY}/workflows/{created['id']}/nodes"

    res = await api.put(f"{base}/plan/agent", {"agentSlug": "implementer"})
    assert res.status_code == 200, res.text
    assert res.json() == {
        "workflowId": created["id"],
        "nodeId": "plan",
        "agentSlug": "implementer",
        "agentName": "Implementer",
        "version": 2,
    }
    res = await api.put(f"{base}/plan/agent", {"agentSlug": None})
    assert res.json()["agentSlug"] is None and res.json()["agentName"] is None and res.json()["version"] == 3
    spec = (await api.get(f"{PAY}/workflows/{created['id']}")).json()["spec"]
    assert spec["nodes"][1]["data"] == {}

    assert error(await api.put(f"{base}/plan/agent", {}), 400) == "agentSlug: Required"
    assert error(await api.put(f"{base}/plan/agent", {"agentSlug": "Bad Slug"}), 400) == "agentSlug: Invalid"
    assert error(await api.put(f"{base}/plan/agent", {"agentSlug": "nope-x"}), 404) == "Agent not found."
    res = await api.put(f"{base}/ok/agent", {"agentSlug": "planner"})
    assert error(res, 400) == '"OK?" is a approval step — only agent steps take an agent.'
    assert error(await api.put(f"{base}/missing/agent", {"agentSlug": "planner"}), 404) == "Workflow step not found."
    # Wayfinder needs a lead; a developer may not edit workflows at all.
    assert error(await api.put(f"{base}/plan/agent", {"agentSlug": "wayfinder"}, as_="dev1"), 403)


async def test_set_step_skills(api: Api, cleanup: Cleanup) -> None:
    created = await create_workflow(api, cleanup)
    skill = await create_agent(api, cleanup, kind="skill")
    path = f"{PAY}/workflows/{created['id']}/nodes/plan/skills"

    res = await api.put(path, {"skills": [skill["slug"], skill["slug"]]})
    assert res.status_code == 200, res.text
    assert res.json() == {
        "workflowId": created["id"],
        "nodeId": "plan",
        "skills": [{"slug": skill["slug"], "name": skill["name"]}],
        "version": 2,
    }
    spec = (await api.get(f"{PAY}/workflows/{created['id']}")).json()["spec"]
    assert spec["nodes"][1]["data"]["skills"] == [skill["slug"]]

    assert error(await api.put(path, {"skills": ["planner"]}), 400) == (
        "Planner is an agent, not a skill — map it as the step's agent instead."
    )
    assert error(await api.put(path, {"skills": ["nope-x"]}), 404) == "Skill nope-x not found."
    assert error(await api.put(path, {"skills": ["Bad!"]}), 400) == "skills.0: Invalid"
    assert error(await api.put(path, {"skills": ["a"] * 21}), 400) == "skills: Array must contain at most 20 element(s)"
    res = await api.put(f"{PAY}/workflows/{created['id']}/nodes/done/skills", {"skills": []})
    assert error(res, 400) == '"Done" is a end step — only agent steps use skills.'

    res = await api.put(path, {"skills": []})
    assert res.json()["skills"] == [] and res.json()["version"] == 3
    spec = (await api.get(f"{PAY}/workflows/{created['id']}")).json()["spec"]
    assert "skills" not in spec["nodes"][1]["data"]


async def test_set_step_harness(api: Api, cleanup: Cleanup) -> None:
    created = await create_workflow(api, cleanup)
    wf = created["id"]
    path = f"{PAY}/workflows/{wf}/nodes/plan/harness"

    res = await api.put(path, {"harness": " Claude-Code "})
    assert res.status_code == 200, res.text
    assert res.json() == {"workflowId": wf, "nodeId": "plan", "harness": "claude-code", "version": 2}
    spec = (await api.get(f"{PAY}/workflows/{wf}")).json()["spec"]
    assert spec["nodes"][1]["data"] == {"agentId": "planner", "agentName": "Planner", "harness": "claude-code"}

    async with read() as conn:
        audit = (
            await conn.execute(
                sa.select(t.audit_log.c.data, t.audit_log.c.via)
                .where(t.audit_log.c.resource_id == wf, t.audit_log.c.action == "workflow.step_harness")
                .order_by(t.audit_log.c.id.desc())
                .limit(1)
            )
        ).one()
    assert audit.data == {"workflow": created["name"], "step": "Plan", "to": "claude-code"}

    res = await api.put(path, {"harness": None})
    assert res.json() == {"workflowId": wf, "nodeId": "plan", "harness": None, "version": 3}
    spec = (await api.get(f"{PAY}/workflows/{wf}")).json()["spec"]
    assert "harness" not in spec["nodes"][1]["data"]

    assert error(await api.put(path, {"harness": "codex"}), 409) == f"Codex {NOT_ALLOWED}"
    assert error(await api.put(path, {"harness": "my-harness"}), 409) == f"My Harness {NOT_ALLOWED}"
    assert error(await api.put(path, {}), 400) == "harness: Required"
    assert error(await api.put(path, {"harness": "bad_id"}), 400) == (
        "harness: A harness id is lowercase letters, digits and dashes."
    )
    res = await api.put(f"{PAY}/workflows/{wf}/nodes/ok/harness", {"harness": "copilot"})
    assert error(res, 400) == '"OK?" is a approval step — only agent steps run in a harness.'
    assert error(await api.put(f"{PAY}/workflows/{wf}/nodes/nope/harness", {"harness": None}), 404) == (
        "Workflow step not found."
    )
    assert error(await api.put(path, {"harness": "copilot"}, as_="viewer"), 403) == (
        "You do not have permission to do that."
    )
    onb = f"/api/v1/projects/ONB/workflows/{wf}/nodes/plan/harness"
    assert error(await api.put(onb, {"harness": "copilot"}, as_="dev1"), 404) == "Project not found."
    assert error(await api.put(onb, {"harness": "copilot"}, as_="lead"), 404) == "Workflow not found."
    # Nothing above changed the workflow.
    assert (await api.get(f"{PAY}/workflows/{wf}")).json()["version"] == 3


# ─── Platform agents and skills ────────────────────────────────────────────────────────────────────────────────


async def test_platform_agent_lifecycle(api: Api, cleanup: Cleanup) -> None:
    agent = await create_agent(api, cleanup, tools=["read", " read ", "edit"], minProjectRole="lead")
    assert set(agent) == AGENT_KEYS | {"instructions"}
    assert agent["source"] == "platform" and agent["enabled"] is True and agent["usable"] is True
    assert agent["tools"] == ["read", "edit"] and agent["requiredRole"] == "lead"
    assert agent["category"] == "general" and agent["sdlcStage"] == "implement" and agent["model"] is None
    slug = agent["slug"]

    flow = await create_workflow(api, cleanup, make_spec(slug))
    assert flow["spec"]["nodes"][1]["data"]["agentName"] == agent["name"]

    # A rename reaches the steps that run it.
    new_name = unique("Renamed agent")
    res = await api.patch(f"{PAY}/agents/{slug}", {"name": new_name, "model": None})
    assert res.status_code == 200, res.text
    assert res.json()["name"] == new_name and res.json()["enabled"] is True
    after = (await api.get(f"{PAY}/workflows/{flow['id']}")).json()
    assert after["version"] == 2 and after["spec"]["nodes"][1]["data"]["agentName"] == new_name
    async with read() as conn:
        fields = (
            await conn.execute(
                sa.select(t.audit_log.c.data)
                .where(t.audit_log.c.resource_id == agent["id"], t.audit_log.c.action == "agent.updated")
                .order_by(t.audit_log.c.id.desc())
                .limit(1)
            )
        ).scalar_one()["fields"]
    assert fields == ["name", "model"]

    # No fields: nothing changes.
    res = await api.patch(f"{PAY}/agents/{slug}", {})
    assert res.status_code == 200 and res.json()["name"] == new_name

    # In use: can't be disabled or deleted.
    used = f"{flow['name']} › Plan"
    res = await api.put(f"{PAY}/agents/{slug}", {"enabled": False})
    assert error(res, 409) == f"{new_name} is mapped to {used}. Map those steps to another agent first."
    res = await api.delete(f"{PAY}/agents/{slug}")
    assert error(res, 409) == f"{new_name} is used by {used}. Remove it from those steps first."
    # A developer may not configure agents (and this one needs a lead anyway).
    assert error(await api.put(f"{PAY}/agents/{slug}", {"enabled": True}, as_="dev1"), 403)

    unbind = await api.put(f"{PAY}/workflows/{flow['id']}/nodes/plan/agent", {"agentSlug": None})
    assert unbind.status_code == 200
    res = await api.put(f"{PAY}/agents/{slug}", {"enabled": False})
    assert res.status_code == 200 and res.json() == {"slug": slug, "enabled": False}
    assert (await api.get(f"{PAY}/agents/{slug}")).json()["enabled"] is False
    res = await api.delete(f"{PAY}/agents/{slug}")
    assert res.status_code == 200 and res.json() == {"ok": True}
    assert error(await api.get(f"{PAY}/agents/{slug}"), 404) == "Agent not found."


async def test_platform_agent_rules(api: Api, cleanup: Cleanup) -> None:
    res = await api.post(f"{PAY}/agents", {"slug": "planner", "name": "P", "description": "d", "instructions": "i"})
    assert error(res, 409) == '"planner" is already used by a built-in agent (Planner). Pick another slug.'
    res = await api.post(f"{PAY}/agents", {"slug": "Not OK", "name": "P", "description": "d", "instructions": "i"})
    assert error(res, 400) == "slug: Use lowercase letters, digits and hyphens."
    res = await api.post(f"{PAY}/agents", {"slug": "fine-slug", "name": "P", "description": " ", "instructions": "i"})
    assert error(res, 400) == "description: Describe what it does."
    res = await api.post(
        f"{PAY}/agents", {"slug": unique("t"), "name": "P", "description": "d", "instructions": "i"}, as_="dev1"
    )
    assert error(res, 403) == "You do not have permission to do that."

    assert error(await api.patch(f"{PAY}/agents/planner", {"name": "X"}), 400) == (
        "Planner is a built-in agent and can't be changed here."
    )
    assert error(await api.delete(f"{PAY}/agents/planner"), 400) == (
        "Planner is a built-in agent and can't be changed here."
    )
    assert error(await api.patch(f"{PAY}/agents/no-such-agent", {"name": "X"}), 404) == "Agent not found."
    assert error(await api.put(f"{PAY}/agents/planner", {}), 400) == "enabled: Required"

    skill = await create_agent(api, cleanup, kind="skill")
    assert skill["kind"] == "skill"
    res = await api.post(f"{PAY}/agents", {"slug": skill["slug"], "name": "P", "description": "d", "instructions": "i"})
    assert (
        error(res, 409)
        == f'"{skill["slug"]}" is already used by a platform skill ({skill["name"]}). Pick another slug.'
    )
