"""A platform run end to end against the dev Postgres: request → claim → each agent step handed to its pinned
harness (plan, human approval, execute) → completed; plus cancel. Drives the service's own routes with the internal
token, the way the gateway does, and a scripted harness in place of VS Code."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import sqlalchemy as sa

from app.config import get_settings
from app.db import tables as t
from app.db.engine import dispose_engine, init_engine, transaction
from app.engine.runner import start_runtime, stop_runtime
from app.main import create_app

pytestmark = pytest.mark.db

CLIENT = "pytest-window-0001"
SPEC = {
    "specVersion": 1,
    "name": "Lifecycle",
    "description": "",
    "pattern": "sequential",
    "budget": {"maxSteps": 50, "timeoutMs": 300000, "maxTokens": 0},
    "nodes": [
        {"id": "start", "kind": "trigger", "label": "Start", "data": {"triggerType": "manual"}},
        {"id": "plan", "kind": "agent", "label": "Plan", "data": {"agentId": "planner", "harness": "claude-code"}},
        {"id": "implement", "kind": "agent", "label": "Implement", "data": {"agentId": "implementer"}},
        {"id": "end", "kind": "end", "label": "Done", "data": {}},
    ],
    "edges": [
        {"source": "start", "target": "plan"},
        {"source": "plan", "target": "implement"},
        {"source": "implement", "target": "end"},
    ],
}


@pytest.fixture
async def env() -> AsyncIterator[dict[str, Any]]:
    settings = get_settings()
    init_engine(settings.sqlalchemy_url)
    await start_runtime(settings)
    async with transaction() as conn:
        users = {
            r.email: r.id
            for r in (
                await conn.execute(
                    sa.select(t.users.c.id, t.users.c.email).where(
                        t.users.c.email.in_(["dev1@sdlc.local", "lead@sdlc.local", "viewer@sdlc.local"])
                    )
                )
            ).all()
        }
        await conn.execute(
            sa.text(
                "insert into client_presence (user_id, client_id, kind, version, engines, last_seen_at) "
                "values (:u, :c, 'vscode', '0.1.0', cast(:e as jsonb), now()) "
                "on conflict (user_id, client_id) do update set engines = excluded.engines, last_seen_at = now()"
            ),
            {
                "u": users["dev1@sdlc.local"],
                "c": CLIENT,
                "e": '[{"engine":"claude-code","installed":true,"version":"2"},'
                '{"engine":"copilot","installed":true,"version":"1"}]',
            },
        )
    transport = httpx.ASGITransport(app=create_app())
    created: dict[str, list[str]] = {"runs": [], "workflows": []}
    async with httpx.AsyncClient(transport=transport, base_url="http://orchestrator") as client:
        yield {"client": client, "users": users, "created": created, "token": settings.ORCHESTRATOR_TOKEN}
    async with transaction() as conn:
        if created["runs"]:
            await conn.execute(t.runs.delete().where(t.runs.c.id.in_(created["runs"])))
        if created["workflows"]:
            await conn.execute(t.workflows.delete().where(t.workflows.c.id.in_(created["workflows"])))
        await conn.execute(t.client_presence.delete().where(t.client_presence.c.client_id == CLIENT))
    await stop_runtime()
    await dispose_engine()


class As:
    def __init__(self, env: dict[str, Any], email: str) -> None:
        self.client: httpx.AsyncClient = env["client"]
        self.headers = {
            "x-sdlc-internal-token": env["token"],
            "x-sdlc-user-id": env["users"][email],
            "x-sdlc-via": "web",
        }

    async def __call__(self, method: str, path: str, body: Any = None, expect: int = 200) -> Any:
        res = await self.client.request(method, "/api/v1" + path, json=body, headers=self.headers, timeout=60)
        assert res.status_code == expect, f"{method} {path} → {res.status_code} {res.text}"
        return res.json()


async def wait_status(run_id: str, status: str) -> None:
    for _ in range(80):
        async with transaction() as conn:
            current = (await conn.execute(sa.select(t.runs.c.status).where(t.runs.c.id == run_id))).scalar_one()
        if current == status:
            return
        await asyncio.sleep(0.1)
    raise AssertionError(f"run {run_id} is {current}, expected {status}")


async def new_run(env: dict[str, Any], dev: As, lead: As) -> str:
    wf = await lead("POST", "/projects/PAY/workflows", {"name": f"Lifecycle {uuid.uuid4().hex[:8]}", "spec": SPEC}, 201)
    env["created"]["workflows"].append(wf["id"])
    req = await dev(
        "POST",
        "/projects/PAY/runs",
        {"storyNumber": 2, "workflowId": wf["id"], "engine": "copilot", "clientId": CLIENT},
        201,
    )
    run_id = str(req["runId"])
    env["created"]["runs"].append(run_id)
    return run_id


async def test_each_step_runs_in_its_harness_until_the_run_completes(env: dict[str, Any]) -> None:
    dev, lead = As(env, "dev1@sdlc.local"), As(env, "lead@sdlc.local")
    run_id = await new_run(env, dev, lead)
    claim = await dev("POST", f"/runs/{run_id}/claim", {"clientId": CLIENT})
    assert claim["driver"] == "orchestrator"
    assert claim["stepHarnesses"] == {"plan": "claude-code", "implement": "copilot"}

    def nxt(harness: str, wait: int = 10) -> Any:
        return dev("GET", f"/projects/PAY/runs/{run_id}/steps/next?harness={harness}&clientId={CLIENT}&wait={wait}")

    a = await nxt("claude-code")
    assert (a["action"], a["nodeId"], a["harness"], a["agentName"]) == ("plan", "plan", "claude-code", "Planner")
    assert "PAY-2" in a["instructions"]
    assert (await nxt("copilot", 0))["action"] == "handoff"

    await dev("POST", f"/projects/PAY/runs/{run_id}/steps/{a['stepId']}/plan", {"plan": "1. Add POST /refunds"})
    await wait_status(run_id, "awaiting_approval")
    assert (await nxt("claude-code", 0))["reason"] == "approval"
    decided = await lead("POST", f"/projects/PAY/runs/{run_id}/approval", {"approve": True})
    assert decided["status"] in ("running", "awaiting_approval")

    a = await nxt("claude-code")
    assert (a["action"], a["approvedPlan"]) == ("execute", "1. Add POST /refunds")
    await dev(
        "POST",
        f"/projects/PAY/runs/{run_id}/steps/{a['stepId']}/complete",
        {"summary": "Planned it.", "outputs": {"Local.Planned": True}},
    )
    for _ in range(20):
        h = await nxt("claude-code", 1)
        if h["action"] != "waiting":
            break
    assert h == {**h, "action": "handoff", "harness": "copilot"}

    a = await nxt("copilot")
    assert (a["action"], a["nodeId"], a["instructions"]) == ("plan", "implement", "Planned it.")
    await dev("POST", f"/projects/PAY/runs/{run_id}/steps/{a['stepId']}/plan", {"plan": "Write the handler"})
    await wait_status(run_id, "awaiting_approval")
    await dev("POST", f"/projects/PAY/runs/{run_id}/approval", {"approve": True})
    a = await nxt("copilot")
    await dev("POST", f"/projects/PAY/runs/{run_id}/steps/{a['stepId']}/complete", {"summary": "Done."})
    assert (await nxt("copilot"))["action"] == "done"
    await wait_status(run_id, "completed")

    async with transaction() as conn:
        steps = (
            await conn.execute(
                sa.select(t.run_steps.c.node_id, t.run_steps.c.status, t.run_steps.c.engine, t.run_steps.c.approval)
                .where(t.run_steps.c.run_id == run_id)
                .order_by(t.run_steps.c.seq)
            )
        ).all()
        assignments = (
            (await conn.execute(sa.select(t.step_assignments.c.status).where(t.step_assignments.c.run_id == run_id)))
            .scalars()
            .all()
        )
    assert [(s.node_id, s.status, s.engine) for s in steps] == [
        ("plan", "succeeded", "claude-code"),
        ("implement", "succeeded", "copilot"),
    ]
    assert steps[0].approval == {"approve": True, "actor": "lead@sdlc.local"}
    assert set(assignments) == {"submitted"} and len(assignments) == 4


async def test_cancel_stops_the_graph_and_the_harness(env: dict[str, Any]) -> None:
    dev, lead = As(env, "dev1@sdlc.local"), As(env, "lead@sdlc.local")
    run_id = await new_run(env, dev, lead)
    await dev("POST", f"/runs/{run_id}/claim", {"clientId": CLIENT})
    a = await dev("GET", f"/projects/PAY/runs/{run_id}/steps/next?harness=claude-code&wait=10")
    assert a["action"] == "plan"
    assert (await lead("POST", f"/projects/PAY/runs/{run_id}/cancel")) == {"ok": True, "delivered": True}
    await wait_status(run_id, "cancelled")
    stopped = await dev("GET", f"/projects/PAY/runs/{run_id}/steps/next?harness=claude-code&wait=0")
    assert stopped["action"] == "stopped"
    await dev("POST", f"/projects/PAY/runs/{run_id}/steps/{a['stepId']}/plan", {"plan": "late"}, 409)
    await lead("POST", f"/projects/PAY/runs/{run_id}/cancel", expect=409)


async def test_a_pinned_harness_must_be_allowed_and_installed(env: dict[str, Any]) -> None:
    dev, lead = As(env, "dev1@sdlc.local"), As(env, "lead@sdlc.local")
    # PAY allows Copilot and Claude Code only: pinning Codex is refused when the workflow is saved.
    spec = {**SPEC, "nodes": [*SPEC["nodes"]]}
    spec["nodes"][2] = {**spec["nodes"][2], "data": {"agentId": "implementer", "harness": "codex"}}
    refused = await lead(
        "POST", "/projects/PAY/workflows", {"name": f"Lifecycle {uuid.uuid4().hex[:8]}", "spec": spec}, 409
    )
    assert refused["message"].startswith('Step "Implement": Codex is not allowed in this project.')

    # The plan step is pinned to Claude Code; a window with only Copilot cannot start the run.
    async with transaction() as conn:
        await conn.execute(
            sa.text("update client_presence set engines = cast(:e as jsonb) where client_id = :c"),
            {"e": '[{"engine":"copilot","installed":true,"version":"1"}]', "c": CLIENT},
        )
    wf = await lead("POST", "/projects/PAY/workflows", {"name": f"Lifecycle {uuid.uuid4().hex[:8]}", "spec": SPEC}, 201)
    env["created"]["workflows"].append(wf["id"])
    res = await dev(
        "POST",
        "/projects/PAY/runs",
        {"storyNumber": 2, "workflowId": wf["id"], "engine": "copilot", "clientId": CLIENT},
        409,
    )
    assert res["error"] == "missing_harnesses"
    assert res["details"] == {"missing": [{"engine": "claude-code", "label": "Claude Code", "nodeIds": ["plan"]}]}


async def test_a_quick_fix_runs_from_a_prompt_without_a_story(env: dict[str, Any]) -> None:
    dev, lead = As(env, "dev1@sdlc.local"), As(env, "lead@sdlc.local")
    wf = await lead("POST", "/projects/PAY/workflows", {"name": f"Lifecycle {uuid.uuid4().hex[:8]}", "spec": SPEC}, 201)
    env["created"]["workflows"].append(wf["id"])
    prompt = "Fix the typo on the checkout button: 'Pay nwo' should read 'Pay now'."
    req = await dev(
        "POST",
        "/projects/PAY/runs",
        {"prompt": f"  {prompt}  ", "workflowId": wf["id"], "engine": "copilot", "clientId": CLIENT},
        201,
    )
    run_id = str(req["runId"])
    env["created"]["runs"].append(run_id)
    assert req["storyNumber"] is None

    async with transaction() as conn:
        row = (await conn.execute(sa.select(t.runs.c.story_id, t.runs.c.prompt).where(t.runs.c.id == run_id))).one()
    assert (row.story_id, row.prompt) == (None, prompt)

    pending = await dev("GET", "/me/runs/pending")
    mine = next(p for p in pending if p["runId"] == run_id)
    assert mine["storyNumber"] is None

    claim = await dev("POST", f"/runs/{run_id}/claim", {"clientId": CLIENT})
    assert (claim["storyNumber"], claim["driver"]) == (None, "orchestrator")

    a = await dev("GET", f"/projects/PAY/runs/{run_id}/steps/next?harness=claude-code&clientId={CLIENT}&wait=10")
    assert a["action"] == "plan" and prompt in a["instructions"]
    assert (await lead("POST", f"/projects/PAY/runs/{run_id}/cancel")) == {"ok": True, "delivered": True}
    await wait_status(run_id, "cancelled")


async def test_a_quick_fix_needs_a_prompt_and_code_edit(env: dict[str, Any]) -> None:
    dev, lead = As(env, "dev1@sdlc.local"), As(env, "lead@sdlc.local")
    viewer = As(env, "viewer@sdlc.local")
    wf = await lead("POST", "/projects/PAY/workflows", {"name": f"Lifecycle {uuid.uuid4().hex[:8]}", "spec": SPEC}, 201)
    env["created"]["workflows"].append(wf["id"])
    body = {"workflowId": wf["id"], "engine": "copilot", "clientId": CLIENT}
    await dev("POST", "/projects/PAY/runs", body, 400)
    await dev("POST", "/projects/PAY/runs", {**body, "prompt": "   "}, 400)
    await dev("POST", "/projects/PAY/runs", {**body, "prompt": "x", "taskNumber": 1}, 400)
    await viewer("POST", "/projects/PAY/runs", {**body, "prompt": "Fix it"}, 403)


async def test_the_only_window_that_can_take_a_run_is_targeted(env: dict[str, Any]) -> None:
    """Untargeted requests are only picked up by a focused window, so the one window that fits gets the run."""
    dev, lead = As(env, "dev1@sdlc.local"), As(env, "lead@sdlc.local")
    unpinned = {
        **SPEC,
        "nodes": [{**n, "data": {k: v for k, v in n["data"].items() if k != "harness"}} for n in SPEC["nodes"]],
    }
    wf = await lead(
        "POST", "/projects/PAY/workflows", {"name": f"Lifecycle {uuid.uuid4().hex[:8]}", "spec": unpinned}, 201
    )
    env["created"]["workflows"].append(wf["id"])
    async with transaction() as conn:
        others = (
            await conn.execute(
                sa.text(
                    "select count(*) from client_presence where user_id = :u and client_id <> :c "
                    "and last_seen_at > now() - interval '3 minutes'"
                ),
                {"u": env["users"]["dev1@sdlc.local"], "c": CLIENT},
            )
        ).scalar_one()
    if others:
        pytest.skip("dev1 has other VS Code windows online in the dev database")
    req = await dev(
        "POST", "/projects/PAY/runs", {"prompt": "Fix the typo", "workflowId": wf["id"], "engine": "copilot"}, 201
    )
    run_id = str(req["runId"])
    env["created"]["runs"].append(run_id)
    async with transaction() as conn:
        target = (await conn.execute(sa.select(t.runs.c.client_id).where(t.runs.c.id == run_id))).scalar_one()
    assert target == CLIENT


async def test_a_done_story_cannot_be_started(env: dict[str, Any]) -> None:
    dev, lead = As(env, "dev1@sdlc.local"), As(env, "lead@sdlc.local")
    wf = await lead("POST", "/projects/PAY/workflows", {"name": f"Lifecycle {uuid.uuid4().hex[:8]}", "spec": SPEC}, 201)
    env["created"]["workflows"].append(wf["id"])
    async with transaction() as conn:
        story = (
            await conn.execute(
                sa.text(
                    "select id, status, is_blocked from stories s join projects p on p.id = s.project_id "
                    "where p.key = 'PAY' and s.number = 2"
                )
            )
        ).one()
        await conn.execute(sa.text("update stories set is_blocked = true where id = :id"), {"id": story.id})
    try:
        res = await dev(
            "POST",
            "/projects/PAY/runs",
            {"storyNumber": 2, "workflowId": wf["id"], "engine": "copilot", "clientId": CLIENT},
            409,
        )
        assert res["error"] == "story_blocked"
    finally:
        async with transaction() as conn:
            await conn.execute(
                sa.text("update stories set is_blocked = :b where id = :id"), {"b": story.is_blocked, "id": story.id}
            )
