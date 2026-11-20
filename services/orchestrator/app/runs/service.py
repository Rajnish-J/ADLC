"""Run lifecycle (port of apps/api/src/services/sessions.ts, plus approvals): request a run of a story in the user's
VS Code, claim it from a VS Code window (which starts the graph), cancel it, record its activity, decide its
approvals, and expire requests nobody picked up.

`request` and `claim` return the run's core facts; the gateway builds the full StoryRun / RunLaunch responses with
its existing presenters, so run views stay in one place.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..access import assert_can, load_project_access
from ..audit import write_audit
from ..config import get_settings
from ..db import tables as t
from ..db.engine import read, transaction
from ..errors import bad_request, conflict, forbidden, gone, not_found
from ..events import publish, run_key, work_changed_run
from ..harnesses import HARNESS_ID, Window, harness_label, online_windows, read_project_settings
from ..http import parse
from ..security import AuthUser, Caller
from ..spec.models import parse_spec

TERMINAL = ("completed", "failed", "cancelled", "expired")
CLIENT_ID = r"^[\w-]{8,64}$"


def choose_window(fitting: list[Window], needed: set[str], repo_client_ids: list[str]) -> str | None:
    """The window a run is sent to when the caller didn't pick one. `fitting` holds the online windows (newest
    first) that have every harness the run needs.

    - A window that has the project's repo open wins: it takes the run over its live connection, with no
      `vscode://` link, so VS Code never opens another window on the wrong folder.
    - With several harnesses the run must go to the one window that has them all.
    - When only one window can take it, target that window: an untargeted request is only picked up by a focused
      window or the deep link, so dismissing the browser's "Open VS Code?" prompt would otherwise let it expire.
    - Otherwise untargeted (None): the focused window, or whichever opens the link, takes it.
    """
    if not fitting:
        return None
    with_repo = next((w for w in fitting if w.client_id in set(repo_client_ids)), None)
    if with_repo is not None:
        return with_repo.client_id
    if len(needed) > 1 or len(fitting) == 1:
        return fitting[0].client_id
    return None


class RequestRunInput(BaseModel):
    """A story (or one of its tasks), or — with no story — a quick fix described by `prompt`. With a story, `prompt`
    is extra instructions."""

    storyNumber: int | None = Field(default=None, gt=0)
    taskNumber: int | None = Field(default=None, gt=0)
    prompt: str | None = Field(default=None, max_length=4_000)
    workflowId: uuid.UUID
    engine: str
    engineModel: str | None = Field(default=None, max_length=120)
    clientId: str | None = Field(default=None, pattern=CLIENT_ID)
    # Set by the gateway, not the browser: the caller's online windows that have the project's repo open (newest
    # first). Without an explicit clientId the run goes to one of these, so the window already on the code takes it.
    repoClientIds: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("engine")
    @classmethod
    def _harness(cls, v: str) -> str:
        v = v.strip().lower()
        if not HARNESS_ID.match(v):
            raise ValueError("A harness id is lowercase letters, digits and dashes.")
        return v

    @field_validator("prompt")
    @classmethod
    def _prompt(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        return v or None

    @model_validator(mode="after")
    def _story_or_prompt(self) -> RequestRunInput:
        if self.storyNumber is None and not self.prompt:
            raise ValueError("Pick a story or describe the fix.")
        if self.taskNumber is not None and self.storyNumber is None:
            raise ValueError("A task needs its story.")
        return self


class ClaimRunInput(BaseModel):
    clientId: str = Field(pattern=CLIENT_ID)


class CancelRunInput(BaseModel):
    reason: str | None = Field(default=None, max_length=2_000)

    @field_validator("reason")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return (v or "").strip() or None


class ApproveRunInput(BaseModel):
    approve: bool
    comment: str | None = Field(default=None, max_length=2_000)
    stepId: str | None = Field(default=None, max_length=200)


RunEventType = Literal[
    "session.started",
    "harness.opened",
    "step.started",
    "plan.submitted",
    "approval.requested",
    "approval.decided",
    "step.completed",
    "agent.started",
    "agent.stopped",
    "skill.used",
    "tool.called",
    "tool.failed",
    "file.changed",
    "memory.read",
    "memory.written",
    "gate.evaluated",
    "turn.stopped",
    "nudge",
    "usage",
]


class RunEventInput(BaseModel):
    seq: int = Field(ge=0)
    at: datetime
    type: RunEventType
    stepId: str | None = Field(default=None, max_length=200)
    agentType: str | None = Field(default=None, max_length=200)
    agentName: str | None = Field(default=None, max_length=200)
    skill: str | None = Field(default=None, max_length=200)
    tool: str | None = Field(default=None, max_length=200)
    path: str | None = Field(default=None, max_length=1_000)
    summary: str | None = Field(default=None, max_length=320)
    data: dict[str, Any] = Field(default_factory=dict)


class ReportRunEventsInput(BaseModel):
    events: list[RunEventInput] = Field(min_length=1, max_length=200)


def _ttl() -> timedelta:
    return timedelta(seconds=get_settings().RUN_REQUEST_TTL_SECONDS)


def _is_expired(status: str, requested_at: datetime | None) -> bool:
    return status == "expired" or (
        status == "requested" and requested_at is not None and datetime.now(UTC) - requested_at > _ttl()
    )


async def _story(conn: Any, project_id: str, number: int) -> Any:
    row = (
        await conn.execute(
            sa.select(t.stories).where(t.stories.c.project_id == project_id, t.stories.c.number == number).limit(1)
        )
    ).first()
    if row is None:
        raise not_found("Story")
    return row


def step_harnesses(spec_raw: dict[str, Any], default_harness: str) -> dict[str, str]:
    """node id → the harness each agent step runs in (its pin, else the run's harness)."""
    spec = parse_spec(spec_raw)
    out: dict[str, str] = {}
    for n in spec.nodes:
        if n.kind == "agent":
            pinned = getattr(n.data, "harness", None)
            out[n.id] = str(pinned) if pinned else default_harness
    return out


# ─── Request (web / extension) ─────────────────────────────────────────────────────────────────────────────────


async def request_run(caller: Caller, key: str, raw: Any) -> dict[str, Any]:
    data = parse(RequestRunInput, raw)
    async with read() as conn:
        access = await load_project_access(conn, caller.user, key)
        story = None
        if data.storyNumber is not None:
            story = await _story(conn, access.project.id, data.storyNumber)
            assert_can(access, "work.report", story.assignee_id)
            if story.status == "done":
                raise conflict("This story is done. Reopen it before starting a run on it.", code="story_done")
            if story.is_blocked:
                raise conflict("This story is blocked. Unblock it before starting a run on it.", code="story_blocked")
        else:
            # A quick fix changes the project's code without a story to own it.
            assert_can(access, "code.edit")
        task = None
        if story is not None and data.taskNumber:
            task = (
                await conn.execute(
                    sa.select(t.story_tasks).where(
                        t.story_tasks.c.story_id == story.id, t.story_tasks.c.number == data.taskNumber
                    )
                )
            ).first()
            if task is None:
                raise not_found("Task")
        workflow = (
            await conn.execute(
                sa.select(t.workflows).where(
                    t.workflows.c.id == str(data.workflowId), t.workflows.c.project_id == access.project.id
                )
            )
        ).first()
        if workflow is None:
            raise not_found("Workflow")

        _default, allowed = read_project_settings(access.project.settings)
        windows = await online_windows(conn, caller.user.id, allowed)
        engine = data.engine
        with_engine = [w for w in windows if engine in w.harnesses]
        if not with_engine:
            raise bad_request(
                f"{harness_label(engine)} is not installed in any of your connected VS Code windows, or this project "
                "does not allow it. Open VS Code with the SDLC extension signed in, then try again."
            )
        if data.clientId and data.clientId not in {w.client_id for w in with_engine}:
            raise bad_request(f"That VS Code window is offline or does not have {harness_label(engine)} installed.")

        # Every pinned step harness must be installed in the SAME window, since one window hosts the whole run.
        per_step = step_harnesses(workflow.spec, engine)
        needed = set(per_step.values()) | {engine}
        candidates = [w for w in with_engine if not data.clientId or w.client_id == data.clientId]
        fit = next((w for w in candidates if needed <= w.harnesses), None)
        if fit is None:
            best = max(candidates, key=lambda w: len(needed & w.harnesses))
            missing = sorted(needed - best.harnesses)
            details = {
                "missing": [
                    {"engine": h, "label": harness_label(h), "nodeIds": [n for n, ph in per_step.items() if ph == h]}
                    for h in missing
                ]
            }
            names = ", ".join(harness_label(h) for h in missing)
            raise conflict(
                f"Some steps of this workflow run in harnesses that are not installed in your VS Code: {names}. "
                "Install them (or change the steps' harness) and try again.",
                details,
                code="missing_harnesses",
            )
        fitting = [w for w in candidates if needed <= w.harnesses]
        client_id = data.clientId or choose_window(fitting, needed, data.repoClientIds)

        engine_model = data.engineModel
        if engine_model is None:
            pref = (
                await conn.execute(
                    sa.select(t.user_preferences.c.engine_model).where(t.user_preferences.c.user_id == caller.user.id)
                )
            ).first()
            engine_model = pref.engine_model if pref else None

    run_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    story_number = story.number if story else None
    async with transaction() as conn:
        await conn.execute(
            t.runs.insert().values(
                id=run_id,
                org_id=caller.user.org_id,
                project_id=access.project.id,
                story_id=story.id if story else None,
                prompt=data.prompt,
                user_id=caller.user.id,
                origin="web",
                driver="orchestrator",
                spec_snapshot=workflow.spec,
                client_run_id=run_id,
                workflow_name=workflow.name,
                workflow_id=workflow.id,
                workflow_version=workflow.version,
                status="requested",
                started_at=now,
                tokens_in=0,
                tokens_out=0,
                changed_files=[],
                engine=engine,
                engine_model=engine_model,
                task_id=task.id if task else None,
                requested_by=caller.user.id,
                requested_at=now,
                client_id=client_id,
            )
        )
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="run.requested",
            resource_type="run",
            resource_id=run_id,
            via=caller.via,
            data={
                "key": run_key(access.project.key, story_number, run_id),
                "task": f"T{task.number}" if task else None,
                "quickFix": story is None or None,
                "workflow": workflow.name,
                "engine": engine,
                "harnesses": sorted(needed) if len(needed) > 1 else None,
            },
        )
        await publish(
            conn,
            {
                "type": "run.requested",
                "targetUserId": caller.user.id,
                "runId": run_id,
                "projectKey": access.project.key,
                "storyNumber": story_number,
                "clientId": client_id,
                "engine": engine,
            },
        )
        await publish(conn, work_changed_run(access.project.key, story_number, run_id, caller.user.id))
    return {"runId": run_id, "projectKey": access.project.key, "storyNumber": story_number, "clientId": client_id}


# ─── Claim (extension) ─────────────────────────────────────────────────────────────────────────────────────────


async def pending_runs(user: AuthUser) -> list[dict[str, Any]]:
    cutoff = datetime.now(UTC) - _ttl()
    async with read() as conn:
        rows = (
            await conn.execute(
                sa.select(
                    t.runs.c.id.label("runId"),
                    t.projects.c.key.label("projectKey"),
                    t.stories.c.number.label("storyNumber"),
                    t.runs.c.client_id.label("clientId"),
                    t.runs.c.engine,
                )
                .join(t.projects, t.projects.c.id == t.runs.c.project_id)
                .outerjoin(t.stories, t.stories.c.id == t.runs.c.story_id)
                .where(t.runs.c.user_id == user.id, t.runs.c.status == "requested", t.runs.c.requested_at > cutoff)
                .order_by(t.runs.c.requested_at)
            )
        ).all()
    return [
        {
            "runId": r.runId,
            "projectKey": r.projectKey,
            "storyNumber": r.storyNumber,
            "clientId": r.clientId,
            "engine": r.engine or "copilot",
        }
        for r in rows
    ]


ACTIVE_STATUSES = ("requested", "queued", "running", "awaiting_approval")


async def active_runs(user: AuthUser) -> list[dict[str, Any]]:
    """The user's runs that have not ended, newest first, each with the agent steps waiting for a harness (handed
    out but not yet answered). The web's run monitor lists them; a reloaded VS Code window re-opens the harness for
    a step it had already been given (`run.step` is only re-sent for steps nobody picked up)."""
    async with read() as conn:
        rows = (
            await conn.execute(
                sa.select(
                    t.runs.c.id.label("runId"),
                    t.projects.c.key.label("projectKey"),
                    t.stories.c.number.label("storyNumber"),
                    t.runs.c.client_id.label("clientId"),
                    t.runs.c.engine,
                    t.runs.c.status,
                    t.runs.c.driver,
                    t.runs.c.workflow_name.label("workflowName"),
                    t.runs.c.workflow_id.label("workflowId"),
                    t.runs.c.prompt,
                    t.runs.c.started_at.label("startedAt"),
                    t.runs.c.updated_at.label("updatedAt"),
                )
                .join(t.projects, t.projects.c.id == t.runs.c.project_id)
                .outerjoin(t.stories, t.stories.c.id == t.runs.c.story_id)
                .where(t.runs.c.user_id == user.id, t.runs.c.status.in_(ACTIVE_STATUSES))
                .order_by(t.runs.c.started_at.desc())
                .limit(50)
            )
        ).all()
        ids = [r.runId for r in rows]
        waiting = (
            (
                await conn.execute(
                    sa.select(
                        t.step_assignments.c.run_id,
                        t.step_assignments.c.step_id,
                        t.step_assignments.c.node_id,
                        t.step_assignments.c.phase,
                        t.step_assignments.c.harness,
                        t.step_assignments.c.status,
                    )
                    .where(
                        t.step_assignments.c.run_id.in_(ids),
                        t.step_assignments.c.status.in_(("pending", "delivered")),
                    )
                    .order_by(t.step_assignments.c.created_at)
                )
            ).all()
            if ids
            else []
        )
    steps: dict[str, list[dict[str, Any]]] = {}
    for w in waiting:
        steps.setdefault(str(w.run_id), []).append(
            {"stepId": w.step_id, "nodeId": w.node_id, "phase": w.phase, "harness": w.harness, "status": w.status}
        )
    return [
        {
            "runId": str(r.runId),
            "projectKey": r.projectKey,
            "storyNumber": r.storyNumber,
            "clientId": r.clientId,
            "engine": r.engine or "copilot",
            "status": r.status,
            "driver": r.driver,
            "workflowName": r.workflowName,
            "workflowId": str(r.workflowId) if r.workflowId else None,
            "prompt": r.prompt,
            "startedAt": r.startedAt.isoformat(),
            "updatedAt": r.updatedAt.isoformat(),
            "waitingSteps": steps.get(str(r.runId), []),
        }
        for r in rows
    ]


async def claim_run(caller: Caller, run_id: str, raw: Any) -> dict[str, Any]:
    """A VS Code window takes a requested run and the graph starts. Idempotent for the same window; another window
    gets 409, a request that waited too long 410."""
    from ..engine.runner import runtime, start_run

    data = parse(ClaimRunInput, raw)
    async with transaction() as conn:
        found = (
            await conn.execute(
                sa.select(t.runs, t.projects.c.key.label("project_key"), t.stories.c.number.label("story_number"))
                .join(t.projects, t.projects.c.id == t.runs.c.project_id)
                .outerjoin(t.stories, t.stories.c.id == t.runs.c.story_id)
                .where(t.runs.c.id == run_id)
                .with_for_update(of=t.runs)
            )
        ).first()
        if found is None or found.org_id != caller.user.org_id:
            raise not_found("Run")
        if found.user_id != caller.user.id:
            raise forbidden("This run was started by someone else; it opens in their VS Code.")
        newly_claimed = False
        if found.claimed_at:
            if found.client_id != data.clientId:
                raise conflict("Another VS Code window already started this run.")
        else:
            if _is_expired(found.status, found.requested_at):
                raise gone("This request expired before VS Code picked it up. Start it again from the web.")
            if found.status != "requested":
                raise conflict(f"This run is {found.status}; it can no longer be started.")
            if found.client_id and found.client_id != data.clientId:
                raise conflict("This run was sent to a different VS Code window.")
            await conn.execute(
                t.runs.update()
                .where(t.runs.c.id == run_id, t.runs.c.status == "requested")
                .values(status="queued", claimed_at=sa.func.now(), client_id=data.clientId, updated_at=sa.func.now())
            )
            await publish(conn, work_changed_run(found.project_key, found.story_number, run_id, caller.user.id))
            newly_claimed = True

    engine = found.engine or "copilot"
    driver = found.driver
    harnesses = step_harnesses(found.spec_snapshot, engine) if driver == "orchestrator" and found.spec_snapshot else {}
    if driver == "orchestrator" and (newly_claimed or found.status == "queued"):
        # Start the graph after the window has its answer; its first assignment arrives as a `run.step` event.
        runtime().spawn(start_run(run_id), f"start {run_id}")
    return {
        "runId": run_id,
        "projectKey": found.project_key,
        "storyNumber": found.story_number,
        "driver": driver,
        "stepHarnesses": harnesses,
    }


# ─── Cancel ────────────────────────────────────────────────────────────────────────────────────────────────────


async def _project_run(conn: Any, access: Any, run_id: str) -> Any:
    found = (
        await conn.execute(
            sa.select(t.runs, t.stories.c.number.label("story_number"))
            .outerjoin(t.stories, t.stories.c.id == t.runs.c.story_id)
            .where(t.runs.c.id == run_id, t.runs.c.project_id == access.project.id)
            .limit(1)
        )
    ).first()
    if found is None:
        raise not_found("Run")
    return found


async def cancel_run(caller: Caller, key: str, run_id: str, raw: Any = None) -> dict[str, Any]:
    from ..engine.runner import cancel_run as cancel_graph

    reason = parse(CancelRunInput, raw or {}).reason

    async with read() as conn:
        access = await load_project_access(conn, caller.user, key)
        run = await _project_run(conn, access, run_id)
    if run.user_id != caller.user.id:
        assert_can(access, "story.assign")
    if run.status in TERMINAL:
        raise conflict(f"This run is already {run.status}.")

    if run.status == "requested":
        async with transaction() as conn:
            await conn.execute(
                t.runs.update()
                .where(t.runs.c.id == run_id)
                .values(status="cancelled", finished_at=sa.func.now(), updated_at=sa.func.now(), error=reason)
            )
            await write_audit(
                conn,
                org_id=caller.user.org_id,
                project_id=access.project.id,
                actor_user_id=caller.user.id,
                action="run.cancelled",
                resource_type="run",
                resource_id=run_id,
                via=caller.via,
                data={
                    "key": run_key(access.project.key, run.story_number, run_id),
                    "workflow": run.workflow_name,
                    "before": "requested",
                },
            )
            await publish(conn, work_changed_run(access.project.key, run.story_number, run_id, caller.user.id))
        return {"ok": True, "delivered": False}

    if run.driver == "orchestrator":
        # The platform runs it: stop the graph here; the VS Code window gets `run.command cancel` to close harnesses.
        await cancel_graph(run_id, caller.user.id, caller.via, reason=reason)
        return {"ok": True, "delivered": True}

    if not run.user_id:
        raise conflict("Nobody is running this run.")
    async with transaction() as conn:
        await publish(
            conn,
            {
                "type": "run.command",
                "targetUserId": run.user_id,
                "runId": run_id,
                "command": "cancel",
                "actorId": caller.user.id,
            },
        )
    return {"ok": True, "delivered": True}


# ─── Approvals ─────────────────────────────────────────────────────────────────────────────────────────────────


async def approve_run(caller: Caller, key: str, run_id: str, raw: Any) -> dict[str, Any]:
    from ..engine.runner import resume_run

    data = parse(ApproveRunInput, raw)
    async with read() as conn:
        access = await load_project_access(conn, caller.user, key)
        run = await _project_run(conn, access, run_id)
        if run.user_id != caller.user.id:
            assert_can(access, "story.assign")
        if run.driver != "orchestrator":
            raise conflict("This run is decided in the VS Code window running it.")
        if run.status != "awaiting_approval" or not run.pending_approval:
            raise conflict(f"This run is {run.status}; nothing is waiting for a decision.")
        pending_step = str(run.pending_approval.get("stepId") or "")
        if data.stepId and data.stepId != pending_step:
            raise conflict("The run has moved past that step. Reload to see what it is waiting for now.")
        label = (
            await conn.execute(
                sa.select(t.run_steps.c.label).where(
                    t.run_steps.c.run_id == run_id, t.run_steps.c.step_id == pending_step
                )
            )
        ).scalar_one_or_none()

    decision: dict[str, Any] = {"approve": data.approve, "actor": caller.user.email}
    if data.comment and data.comment.strip():
        decision["comment"] = data.comment.strip()

    def match(value: dict[str, Any]) -> bool:
        return value.get("kind") in ("agent-plan", "approval") and value.get("stepId") == pending_step

    async with transaction() as conn:
        await write_audit(
            conn,
            org_id=caller.user.org_id,
            project_id=access.project.id,
            actor_user_id=caller.user.id,
            action="run.approval_decided",
            resource_type="run",
            resource_id=run_id,
            via=caller.via,
            data={
                "key": run_key(access.project.key, run.story_number, run_id),
                "workflow": run.workflow_name,
                "step": label or pending_step,
                "approve": data.approve,
                "comment": decision.get("comment"),
            },
        )
    status = await resume_run(run_id, match, decision)
    return {"ok": True, "status": status}


# ─── Activity events ───────────────────────────────────────────────────────────────────────────────────────────


async def report_run_events(caller: Caller, key: str, run_id: str, raw: Any) -> dict[str, Any]:
    data = parse(ReportRunEventsInput, raw)
    async with transaction() as conn:
        access = await load_project_access(conn, caller.user, key)
        run = await _project_run(conn, access, run_id)
        if run.user_id != caller.user.id:
            raise forbidden("Only the VS Code window running this run reports its activity.")
        rows = [
            {
                "run_id": run_id,
                "seq": e.seq,
                "at": e.at,
                "type": e.type,
                "step_id": e.stepId,
                "agent_type": e.agentType,
                "agent_name": e.agentName,
                "skill": e.skill,
                "tool": e.tool,
                "path": e.path,
                "summary": e.summary[:320] if e.summary else None,
                "data": e.data,
            }
            for e in data.events
        ]
        await conn.execute(
            pg_insert(t.run_events).values(rows).on_conflict_do_nothing(index_elements=["run_id", "seq"])
        )
        # The harness's own session id (from its first hook), so the run can be found in the harness's history.
        session_ids = (e.data.get("engineSessionId") for e in data.events)
        session_id = next((s[:200] for s in session_ids if isinstance(s, str) and s), None)
        if session_id:
            await conn.execute(
                t.runs.update()
                .where(t.runs.c.id == run_id, t.runs.c.engine_session_id.is_(None))
                .values(engine_session_id=session_id)
            )
        last_seq = await _last_seq(conn, run_id)
        await publish(
            conn,
            {
                "type": "run.activity",
                "projectKey": access.project.key,
                "storyNumber": run.story_number,
                "runId": run_id,
                "lastSeq": last_seq,
            },
        )
    return {"lastSeq": last_seq}


async def _last_seq(conn: Any, run_id: str) -> int:
    value = (
        await conn.execute(sa.select(sa.func.max(t.run_events.c.seq)).where(t.run_events.c.run_id == run_id))
    ).scalar()
    return int(value) if value is not None else -1


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def list_run_events(user: AuthUser, key: str, run_id: str, after: int, limit: int) -> dict[str, Any]:
    async with read() as conn:
        access = await load_project_access(conn, user, key)
        await _project_run(conn, access, run_id)
        rows = (
            await conn.execute(
                sa.select(t.run_events)
                .where(t.run_events.c.run_id == run_id, t.run_events.c.seq > after)
                .order_by(t.run_events.c.seq)
                .limit(limit)
            )
        ).all()
        last_seq = await _last_seq(conn, run_id)
    return {
        "events": [
            {
                "seq": r.seq,
                "at": _iso(r.at),
                "type": r.type,
                "stepId": r.step_id,
                "agentType": r.agent_type,
                "agentName": r.agent_name,
                "skill": r.skill,
                "tool": r.tool,
                "path": r.path,
                "summary": r.summary,
                "data": r.data,
            }
            for r in rows
        ],
        "lastSeq": last_seq,
    }


# ─── Expiry ────────────────────────────────────────────────────────────────────────────────────────────────────


async def expire_requested_runs() -> int:
    cutoff = datetime.now(UTC) - _ttl()
    async with transaction() as conn:
        expired = (
            await conn.execute(
                t.runs.update()
                .where(t.runs.c.status == "requested", t.runs.c.requested_at < cutoff)
                .values(
                    status="expired",
                    finished_at=sa.func.now(),
                    updated_at=sa.func.now(),
                    error="No VS Code window picked up the run in time.",
                )
                .returning(t.runs.c.id)
            )
        ).all()
        if not expired:
            return 0
        keys = (
            await conn.execute(
                sa.select(t.runs.c.id, t.projects.c.key, t.stories.c.number)
                .join(t.projects, t.projects.c.id == t.runs.c.project_id)
                .outerjoin(t.stories, t.stories.c.id == t.runs.c.story_id)
                .where(t.runs.c.id.in_([r.id for r in expired]))
            )
        ).all()
        for k in keys:
            await publish(conn, work_changed_run(k.key, k.number, k.id, None))
    return len(expired)
