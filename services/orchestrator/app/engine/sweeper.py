"""Background upkeep, every SWEEP_INTERVAL_SECONDS:

- expire run requests no VS Code window claimed in time;
- start claimed runs whose graph never started (the process died between the claim and the start);
- recover runs whose process died mid-step: replay from the last checkpoint, and resume steps whose harness result
  was recorded but never applied;
- re-announce (`run.step`) agent steps no harness has picked up, so a VS Code window that missed the event opens it;
- fail runs that ran past their active-time budget (time waiting on a person does not count);
- fail runs whose VS Code window went away (closed, or signed out) while one of their agent steps was out with it —
  nothing else would ever pick that step up, and the run would look "running" until its budget ran out;
- tell the gateway again about ended runs it never confirmed (memory capture, profile update).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import sqlalchemy as sa

from ..db import tables as t
from ..db.engine import read, transaction
from ..events import publish
from ..harness.assignments import step_event, undelivered

if TYPE_CHECKING:
    from .runner import Runtime

log = logging.getLogger("orchestrator.sweeper")

REANNOUNCE_AFTER_SECONDS = 30
STALE_DRIVE = timedelta(seconds=60)
# A window that hasn't reported for this long is gone (it beats every minute; a reload is back within seconds).
WINDOW_GONE_AFTER = timedelta(minutes=10)
WINDOW_GONE = "The VS Code window running this run was closed or went offline. Start it again from the web."
# Ended runs the gateway never confirmed: wait out the first callback's own retries, give up after a day.
RENOTIFY_AFTER = timedelta(seconds=60)
RENOTIFY_WITHIN = timedelta(days=1)
_renotifying: set[str] = set()


async def sweep_forever(rt: Runtime) -> None:
    interval = rt.settings.SWEEP_INTERVAL_SECONDS
    while True:
        try:
            await sweep_once(rt)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — upkeep must never stop
            log.exception("Sweep failed")
        await asyncio.sleep(interval)


async def sweep_once(rt: Runtime) -> None:
    from ..runs.service import expire_requested_runs

    expired = await expire_requested_runs()
    if expired:
        log.info("Expired %d unclaimed run request(s)", expired)
    await _recover(rt)
    await _reannounce()
    await _renotify(rt)


def window_gone(last_seen: datetime | None, now: datetime, outstanding_step: bool) -> bool:
    """A run's window is gone for good when it stopped reporting a while ago while it had an agent step to run."""
    if not outstanding_step:
        return False
    return last_seen is None or now - last_seen > WINDOW_GONE_AFTER


async def _window_state(run_id: str, user_id: str | None, client_id: str) -> tuple[datetime | None, bool]:
    """When the run's window last reported, and whether one of its agent steps is waiting on (or out with) it."""
    async with read() as conn:
        last_seen = (
            await conn.execute(
                sa.select(t.client_presence.c.last_seen_at).where(
                    t.client_presence.c.user_id == user_id, t.client_presence.c.client_id == client_id
                )
            )
        ).scalar_one_or_none()
        outstanding = (
            await conn.execute(
                sa.select(sa.func.count())
                .select_from(t.step_assignments)
                .where(
                    t.step_assignments.c.run_id == run_id,
                    t.step_assignments.c.status.in_(("pending", "delivered")),
                )
            )
        ).scalar_one()
    return last_seen, outstanding > 0


async def _recover(rt: Runtime) -> None:
    from .runner import _config, _finish, _graph, continue_run, load_ctx, now_ms, resume_run, start_run

    cutoff = datetime.now(UTC) - STALE_DRIVE
    async with read() as conn:
        rows = (
            await conn.execute(
                sa.select(
                    t.runs.c.id, t.runs.c.status, t.runs.c.updated_at, t.runs.c.user_id, t.runs.c.client_id
                ).where(
                    t.runs.c.driver == "orchestrator",
                    t.runs.c.status.in_(("queued", "running", "awaiting_approval")),
                )
            )
        ).all()
    for row in rows:
        if rt.lock(row.id).locked():
            continue  # being driven right now
        try:
            async with read() as conn:
                ctx = await load_ctx(conn, row.id)
            graph = _graph(rt, ctx)
            state = await graph.aget_state(_config(row.id))
            values: dict[str, Any] = state.values or {}

            if not values:
                if row.status == "queued" and row.updated_at < cutoff:
                    log.info("Starting run %s, whose graph never started", row.id)
                    rt.spawn(start_run(row.id), f"start {row.id}")
                continue

            # Active-time budget: elapsed since start, minus time paused on people, minus the current human pause.
            started = int(values.get("startedAt") or now_ms())
            paused = int(values.get("pausedMs") or 0)
            if row.status == "awaiting_approval":
                paused += max(0, now_ms() - int(values.get("lastActiveAt") or now_ms()))
            if now_ms() - started - paused > ctx.budget.timeoutMs:
                minutes = ctx.budget.timeoutMs // 60_000
                log.info("Run %s ran past its %d-minute budget", row.id, minutes)
                async with rt.lock(row.id):
                    await _finish(
                        rt, ctx, graph, "failed", f"Run exceeded its time budget ({minutes} minutes of work)."
                    )
                continue

            # Its window is gone: the step it holds would never come back. (Waiting on a person is not affected.)
            if row.status in ("queued", "running") and row.client_id:
                last_seen, outstanding = await _window_state(row.id, row.user_id, row.client_id)
                if window_gone(last_seen, datetime.now(UTC), outstanding):
                    log.info("Run %s lost its VS Code window %s", row.id, row.client_id)
                    async with rt.lock(row.id):
                        await _finish(rt, ctx, graph, "failed", WINDOW_GONE)
                    continue

            submitted = await _submitted_but_waiting(row.id, state.interrupts)
            for step_id, phase, result in submitted:
                log.info("Resuming run %s with the recorded %s of %s", row.id, phase, step_id)

                def match(v: dict[str, Any], s: str = step_id, p: str = phase) -> bool:
                    return v.get("kind") == "harness" and v.get("stepId") == s and v.get("phase") == p

                rt.spawn(resume_run(row.id, match, result), f"recover {row.id}")
            if not submitted and state.next and not state.interrupts and row.updated_at < cutoff:
                log.info("Continuing run %s from its last checkpoint", row.id)
                rt.spawn(continue_run(row.id), f"continue {row.id}")
        except Exception:  # noqa: BLE001
            log.exception("Could not check run %s", row.id)


async def _submitted_but_waiting(run_id: str, interrupts: Any) -> list[tuple[str, str, dict[str, Any]]]:
    waiting = {
        (i.value.get("stepId"), i.value.get("phase"))
        for i in interrupts
        if isinstance(i.value, dict) and i.value.get("kind") == "harness"
    }
    if not waiting:
        return []
    async with read() as conn:
        rows = (
            await conn.execute(
                sa.select(t.step_assignments.c.step_id, t.step_assignments.c.phase, t.step_assignments.c.result).where(
                    t.step_assignments.c.run_id == run_id, t.step_assignments.c.status == "submitted"
                )
            )
        ).all()
    return [(r.step_id, r.phase, r.result or {}) for r in rows if (r.step_id, r.phase) in waiting]


async def _reannounce() -> None:
    from .runner import load_ctx

    rows = await undelivered(REANNOUNCE_AFTER_SECONDS)
    for r in rows:
        try:
            async with transaction() as conn:
                ctx = await load_ctx(conn, r.run_id)
                if ctx.user_id:
                    await publish(conn, step_event(ctx, r.step_id, r.node_id, r.phase, r.harness))
        except Exception:  # noqa: BLE001
            log.exception("Could not re-announce step %s of run %s", r.step_id, r.run_id)


async def _renotify(rt: Runtime) -> None:
    from .runner import _notify_finished

    now = datetime.now(UTC)
    async with read() as conn:
        ids = (
            (
                await conn.execute(
                    sa.select(t.runs.c.id).where(
                        t.runs.c.driver == "orchestrator",
                        t.runs.c.status.in_(("completed", "failed", "cancelled")),
                        t.runs.c.finish_notified_at.is_(None),
                        t.runs.c.finished_at < now - RENOTIFY_AFTER,
                        t.runs.c.finished_at > now - RENOTIFY_WITHIN,
                    )
                )
            )
            .scalars()
            .all()
        )
    for run_id in ids:
        if run_id in _renotifying:
            continue
        _renotifying.add(run_id)

        async def once(r: str = run_id) -> None:
            try:
                await _notify_finished(rt, r, backoff=(0.0,))
            finally:
                _renotifying.discard(r)

        rt.spawn(once(), f"re-notify {run_id}")
