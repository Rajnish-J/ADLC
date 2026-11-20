"""Agent steps handed to harnesses. The graph's `_req` nodes record one assignment per (step, phase) for the step's
harness; the harness in the user's VS Code takes it with `sdlc_next_step` (a long-poll through the gateway), and its
plan or result resumes the graph at that step's interrupt.

A harness only ever gets its own steps. When the next step belongs to another harness it is told `handoff` and
ends its turn; the extension opens the other harness when it sees the `run.step` event for it.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from ..access import load_project_access
from ..db import tables as t
from ..db.engine import read, transaction
from ..errors import conflict, forbidden, not_found
from ..events import publish
from ..harnesses import harness_label
from ..security import Caller

if TYPE_CHECKING:
    from ..engine.runner import RunCtx

TERMINAL = frozenset({"completed", "failed", "cancelled", "expired"})
OPEN = ("pending", "delivered")


def step_event(ctx: RunCtx, step_id: str, node_id: str, phase: str, harness: str) -> dict[str, Any]:
    return {
        "type": "run.step",
        "targetUserId": ctx.user_id,
        "runId": ctx.run_id,
        "projectKey": ctx.project_key,
        "storyNumber": ctx.story_number,
        "stepId": step_id,
        "nodeId": node_id,
        "phase": phase,
        "harness": harness,
        "clientId": ctx.client_id,
    }


async def create_assignment(
    ctx: RunCtx, step: dict[str, Any], node_id: str, phase: str, harness: str, payload: dict[str, Any]
) -> None:
    """Idempotent on (run, step, phase): replaying a `_req` node never hands the same step out twice."""
    async with transaction() as conn:
        stmt = (
            pg_insert(t.step_assignments)
            .values(
                run_id=ctx.run_id,
                step_id=step["id"],
                node_id=node_id,
                phase=phase,
                harness=harness,
                payload=payload,
                status="pending",
            )
            .on_conflict_do_nothing(
                index_elements=[t.step_assignments.c.run_id, t.step_assignments.c.step_id, t.step_assignments.c.phase]
            )
        )
        await conn.execute(stmt)
        if ctx.user_id:
            await publish(conn, step_event(ctx, step["id"], node_id, phase, harness))


async def _run_for_harness(conn: AsyncConnection, caller: Caller, key: str, run_id: str) -> Any:
    access = await load_project_access(conn, caller.user, key)
    run = (
        await conn.execute(
            sa.select(t.runs).where(t.runs.c.id == run_id, t.runs.c.project_id == access.project.id).limit(1)
        )
    ).first()
    if run is None:
        raise not_found("Run")
    if run.user_id != caller.user.id:
        raise forbidden("Only the VS Code window running this run works on its steps.")
    if run.driver != "orchestrator":
        raise conflict("This run is driven by VS Code, not by the platform.")
    return run


def _waiting(reason: str, run_status: str) -> dict[str, Any]:
    if reason == "approval":
        return {
            "action": "waiting",
            "reason": "approval",
            "retryAfterSec": 20,
            "message": "The run is waiting for a person to approve a plan or a step — on the web or in VS Code. "
            "Call sdlc_next_step again in a moment.",
        }
    return {
        "action": "waiting",
        "reason": "idle",
        "retryAfterSec": 5,
        "message": "No step for you yet"
        + (" (the run is starting)." if run_status in ("requested", "queued") else ".")
        + " Call sdlc_next_step again in a moment.",
    }


async def next_step(caller: Caller, key: str, run_id: str, harness: str, wait_seconds: int) -> dict[str, Any]:
    from ..engine.runner import runtime

    rt = runtime()
    deadline = time.monotonic() + max(0, min(wait_seconds, 50))
    while True:
        async with transaction() as conn:
            run = await _run_for_harness(conn, caller, key, run_id)
            if run.status in TERMINAL:
                return (
                    {"action": "done"}
                    if run.status == "completed"
                    else {"action": "stopped", "reason": run.error or f"The run is {run.status}."}
                )
            open_rows = (
                await conn.execute(
                    sa.select(t.step_assignments)
                    .where(t.step_assignments.c.run_id == run_id, t.step_assignments.c.status.in_(OPEN))
                    .order_by(t.step_assignments.c.created_at)
                )
            ).all()
            mine = next((a for a in open_rows if a.harness == harness), None)
            if mine is not None:
                if mine.status == "pending":
                    await conn.execute(
                        t.step_assignments.update()
                        .where(t.step_assignments.c.id == mine.id)
                        .values(status="delivered", delivered_at=sa.func.now())
                    )
                return {**mine.payload, "harness": mine.harness}
            other = next((a for a in open_rows if a.harness != harness), None)
            if other is not None:
                label = harness_label(other.harness)
                return {
                    "action": "handoff",
                    "harness": other.harness,
                    "message": f"The next step ({other.payload.get('agentName') or other.node_id}) runs in {label}. "
                    "Stop here and end your turn; you will be started again when a step needs you.",
                }
            reason = "approval" if run.status == "awaiting_approval" else "idle"
            status = run.status
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return _waiting(reason, status)
        await rt.changed(run_id, min(remaining, 2.0))


async def _submit(caller: Caller, key: str, run_id: str, step_id: str, phase: str, result: dict[str, Any]) -> None:
    from ..engine.runner import resume_run, runtime

    async with transaction() as conn:
        await _run_for_harness(conn, caller, key, run_id)
        rows = (
            await conn.execute(
                sa.select(t.step_assignments)
                .where(t.step_assignments.c.run_id == run_id, t.step_assignments.c.step_id == step_id)
                .with_for_update()
            )
        ).all()
        row = next((r for r in rows if r.phase == phase), None)
        if row is None:
            if rows:
                raise conflict(
                    "This step is waiting for its result, not a plan."
                    if phase == "plan"
                    else "This step has no approved plan yet."
                )
            raise not_found("Step")
        if row.status == "submitted":
            return  # a retried call — the first one already resumed the run
        if row.status == "cancelled":
            raise conflict("This step was cancelled.")
        await conn.execute(
            t.step_assignments.update()
            .where(t.step_assignments.c.id == row.id)
            .values(status="submitted", result=result, submitted_at=sa.func.now())
        )

    def match(value: dict[str, Any]) -> bool:
        return value.get("kind") == "harness" and value.get("stepId") == step_id and value.get("phase") == phase

    # Driving to the next interrupt can take a while (gates); the harness gets its ack now. If this process dies
    # first, the sweeper resumes it from the submitted assignment.
    runtime().spawn(resume_run(run_id, match, result), f"resume {run_id} after {phase} of {step_id}")


async def submit_plan(
    caller: Caller, key: str, run_id: str, step_id: str, plan: str, tokens_in: int, tokens_out: int
) -> dict[str, Any]:
    await _submit(caller, key, run_id, step_id, "plan", {"plan": plan, "tokensIn": tokens_in, "tokensOut": tokens_out})
    return {"ok": True, "stepId": step_id}


async def complete_step(caller: Caller, key: str, run_id: str, step_id: str, result: dict[str, Any]) -> dict[str, Any]:
    await _submit(caller, key, run_id, step_id, "execute", result)
    return {"ok": True, "stepId": step_id}


async def undelivered(older_than_seconds: int) -> list[Any]:
    """Assignments no harness has picked up for a while — the sweeper re-announces them."""
    async with read() as conn:
        return list(
            (
                await conn.execute(
                    sa.select(
                        t.step_assignments.c.run_id,
                        t.step_assignments.c.step_id,
                        t.step_assignments.c.node_id,
                        t.step_assignments.c.phase,
                        t.step_assignments.c.harness,
                    ).where(
                        t.step_assignments.c.status == "pending",
                        t.step_assignments.c.created_at
                        < sa.func.now() - sa.text(f"interval '{int(older_than_seconds)} seconds'"),
                    )
                )
            ).all()
        )
