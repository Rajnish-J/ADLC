"""Drives orchestrator runs: compiles a run's spec into its LangGraph graph (checkpointed by AsyncPostgresSaver in the
`orchestrator` schema, thread id = run id), streams it until every branch is waiting on an interrupt or the run ends,
and mirrors the graph state into `runs` / `run_steps` so the web and the extension read it like any other run.

Nothing is held in memory between steps: a harness's plan or result, and a human decision, resume the graph from
its checkpoint with `Command(resume={interrupt_id: value})`. A per-run lock serialises everything that drives one
run inside this process; a Postgres advisory lock does the same across processes.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import sqlalchemy as sa
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from ..audit import write_audit
from ..config import Settings
from ..db import tables as t
from ..db.engine import read, transaction
from ..errors import conflict, not_found
from ..events import publish, run_key, work_changed_run
from ..gates.stub import StubGateEvaluator
from ..spec.models import RunBudget, WorkflowSpec, parse_spec
from .compiler import LAST_MESSAGE_KEY, RUN_FAILURE_KEY, AgentInfo, CompileDeps, compile_run_graph
from .state import Step

log = logging.getLogger("orchestrator.runner")

TERMINAL = frozenset({"completed", "failed", "cancelled", "expired"})
MAX_OUTPUT = 8_000
MAX_PLAN = 4_000


def now_ms() -> int:
    return int(time.time() * 1000)


def _dt(ms: int | None) -> datetime | None:
    return datetime.fromtimestamp(ms / 1000, tz=UTC) if ms else None


def _clip(text: Any, limit: int) -> str | None:
    if text is None:
        return None
    s = str(text)
    return s if len(s) <= limit else s[: limit - 1] + "…"


# ─── Process-wide runtime ──────────────────────────────────────────────────────────────────────────────────────


@dataclass
class RunCtx:
    """Everything about a run the graph and the persistence need, loaded once per drive."""

    run_id: str
    org_id: str
    project_id: str
    project_key: str
    story_id: str | None
    #: None for a quick fix started from a prompt.
    story_number: int | None
    user_id: str | None
    client_id: str | None
    engine: str
    workflow_name: str
    spec: WorkflowSpec
    budget: RunBudget


class Runtime:
    def __init__(self, settings: Settings, pool: AsyncConnectionPool, saver: AsyncPostgresSaver) -> None:
        self.settings = settings
        self.pool = pool
        self.saver = saver
        self.locks: dict[str, asyncio.Lock] = {}
        self.signals: dict[str, asyncio.Event] = {}
        self.tasks: set[asyncio.Task[Any]] = set()
        self.sweeper: asyncio.Task[None] | None = None
        self.gate = StubGateEvaluator()
        self.http = httpx.AsyncClient(timeout=10)

    def lock(self, run_id: str) -> asyncio.Lock:
        return self.locks.setdefault(run_id, asyncio.Lock())

    def wake(self, run_id: str) -> None:
        """Wake long-polls waiting on this run (a new assignment, a decision, the run ending)."""
        event = self.signals.pop(run_id, None)
        if event:
            event.set()

    async def changed(self, run_id: str, wait_seconds: float) -> None:
        event = self.signals.setdefault(run_id, asyncio.Event())
        try:
            async with asyncio.timeout(wait_seconds):
                await event.wait()
        except TimeoutError:
            pass

    def spawn(self, coro: Any, what: str) -> None:
        task = asyncio.create_task(coro)
        self.tasks.add(task)

        def done(t: asyncio.Task[Any]) -> None:
            self.tasks.discard(t)
            if not t.cancelled() and t.exception():
                log.error("%s failed", what, exc_info=t.exception())

        task.add_done_callback(done)


_runtime: Runtime | None = None


def runtime() -> Runtime:
    if _runtime is None:
        raise RuntimeError("The orchestrator runtime is not started.")
    return _runtime


async def start_runtime(settings: Settings) -> None:
    global _runtime
    pool = AsyncConnectionPool(
        conninfo=settings.psycopg_url,
        max_size=10,
        open=False,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            # LangGraph's checkpoint tables live in their own schema, apart from the Drizzle-managed public one.
            "options": "-c search_path=orchestrator",
        },
    )
    await pool.open(wait=True)
    saver = AsyncPostgresSaver(pool)  # type: ignore[arg-type]
    await saver.setup()
    _runtime = Runtime(settings, pool, saver)
    from .sweeper import sweep_forever

    _runtime.sweeper = asyncio.create_task(sweep_forever(_runtime))


async def stop_runtime() -> None:
    global _runtime
    rt = _runtime
    _runtime = None
    if rt is None:
        return
    if rt.sweeper:
        rt.sweeper.cancel()
    for task in list(rt.tasks):
        task.cancel()
    await rt.http.aclose()
    await rt.pool.close()


def runtime_status() -> dict[str, Any]:
    rt = _runtime
    return {"runtime": "ready" if rt else "stopped", "activeDrives": len(rt.tasks) if rt else 0}


# ─── Loading a run ─────────────────────────────────────────────────────────────────────────────────────────────


async def load_ctx(conn: AsyncConnection, run_id: str) -> RunCtx:
    row = (
        await conn.execute(
            sa.select(t.runs, t.projects.c.key.label("project_key"), t.stories.c.number.label("story_number"))
            .join(t.projects, t.projects.c.id == t.runs.c.project_id)
            .join(t.stories, t.stories.c.id == t.runs.c.story_id, isouter=True)
            .where(t.runs.c.id == run_id)
        )
    ).first()
    if row is None:
        raise not_found("Run")
    if row.driver != "orchestrator" or not row.spec_snapshot:
        raise conflict("This run is not driven by the orchestrator.")
    spec = parse_spec(row.spec_snapshot)
    settings = runtime().settings
    # Agent steps run in a harness and wait on people, so they get a much longer clock than the spec default; token
    # use is not reported reliably by harnesses, so there is no token ceiling.
    budget = RunBudget(maxSteps=spec.budget.maxSteps, timeoutMs=settings.RUN_TIMEOUT_MINUTES * 60_000, maxTokens=0)
    return RunCtx(
        run_id=row.id,
        org_id=row.org_id,
        project_id=row.project_id,
        project_key=row.project_key,
        story_id=row.story_id,
        story_number=row.story_number,
        user_id=row.user_id,
        client_id=row.client_id,
        engine=row.engine or "copilot",
        workflow_name=row.workflow_name,
        spec=spec,
        budget=budget,
    )


def _graph(rt: Runtime, ctx: RunCtx) -> CompiledStateGraph:
    async def assign(step: Step, node_id: str, phase: str, harness: str, payload: dict[str, Any]) -> None:
        from ..harness.assignments import create_assignment

        await create_assignment(ctx, step, node_id, phase, harness, payload)
        rt.wake(ctx.run_id)

    async def describe_agent(slug: str) -> AgentInfo | None:
        async with read() as conn:
            row = (
                await conn.execute(
                    sa.select(t.agents.c.slug, t.agents.c.name, t.agents.c.instructions)
                    .where(
                        t.agents.c.slug == slug,
                        t.agents.c.kind == "agent",
                        sa.or_(t.agents.c.project_id.is_(None), t.agents.c.project_id == ctx.project_id),
                    )
                    .order_by(t.agents.c.project_id.is_(None))
                    .limit(1)
                )
            ).first()
        return AgentInfo(slug=row.slug, name=row.name, instructions=row.instructions) if row else None

    async def describe_skills(slugs: list[str]) -> list[dict[str, str]]:
        async with read() as conn:
            rows = (
                await conn.execute(
                    sa.select(t.agents.c.slug, t.agents.c.name).where(
                        t.agents.c.slug.in_(slugs),
                        t.agents.c.kind == "skill",
                        sa.or_(t.agents.c.project_id.is_(None), t.agents.c.project_id == ctx.project_id),
                    )
                )
            ).all()
        names = {r.slug: r.name for r in rows}
        return [{"slug": s, "name": names.get(s, s)} for s in slugs]

    deps = CompileDeps(
        run_id=ctx.run_id,
        budget=ctx.budget,
        default_harness=ctx.engine,
        now=now_ms,
        gate=rt.gate,
        assign=assign,
        describe_agent=describe_agent,
        describe_skills=describe_skills,
    )
    return compile_run_graph(ctx.spec, deps, rt.saver)


def _config(run_id: str) -> RunnableConfig:
    return {"configurable": {"thread_id": run_id}, "recursion_limit": 10_000}


def _advisory_key(run_id: str) -> int:
    return int.from_bytes(hashlib.sha256(run_id.encode()).digest()[:8], "big", signed=True)


# ─── Seed ──────────────────────────────────────────────────────────────────────────────────────────────────────


async def _seed(conn: AsyncConnection, ctx: RunCtx) -> dict[str, Any]:
    run = (await conn.execute(sa.select(t.runs.c.task_id, t.runs.c.prompt).where(t.runs.c.id == ctx.run_id))).first()
    story = (
        (await conn.execute(sa.select(t.stories).where(t.stories.c.id == ctx.story_id))).first()
        if ctx.story_id
        else None
    )
    story_key = run_key(ctx.project_key, ctx.story_number, ctx.run_id)
    prompt = (run.prompt or "").strip() if run is not None else ""
    lines: list[str] = []
    if story is not None:
        lines.append(f"{story_key}: {story.title}")
        if story.description:
            lines += ["", story.description]
        criteria = [c.get("text") for c in (story.acceptance_criteria or []) if isinstance(c, dict) and c.get("text")]
        if criteria:
            lines += ["", "Acceptance criteria:", *[f"- {c}" for c in criteria]]
    task_number = None
    if run is not None and run.task_id:
        task = (await conn.execute(sa.select(t.story_tasks).where(t.story_tasks.c.id == run.task_id))).first()
        if task is not None:
            task_number = task.number
            lines += ["", f"Task T{task.number}: {task.title}"]
            if task.description:
                lines.append(task.description)
    if prompt:
        # No story: the prompt is the work item. With a story: extra instructions on top of it.
        lines += [prompt] if story is None else ["", "Additional instructions:", prompt]
    text = "\n".join(lines) or story_key
    variables: dict[str, Any] = {
        "task": text,
        "storyKey": story_key,
        "engine": ctx.engine,
        LAST_MESSAGE_KEY: text,
        "Local.WorkItem": text,
    }
    if task_number is not None:
        variables["taskNumber"] = task_number
    return variables


# ─── Driving ───────────────────────────────────────────────────────────────────────────────────────────────────


async def start_run(run_id: str) -> None:
    """Start a claimed run's graph. Idempotent: a run that already has a checkpoint is only re-settled."""
    rt = runtime()
    async with rt.lock(run_id):
        async with read() as conn:
            ctx = await load_ctx(conn, run_id)
            status = (await conn.execute(sa.select(t.runs.c.status).where(t.runs.c.id == run_id))).scalar_one()
            seed = await _seed(conn, ctx)
        if status in TERMINAL:
            return
        graph = _graph(rt, ctx)
        existing = await graph.aget_state(_config(run_id))
        if existing.values:
            await _settle(rt, ctx, graph)
            return
        async with transaction() as conn:
            await conn.execute(
                t.runs.update().where(t.runs.c.id == run_id).values(status="running", updated_at=sa.func.now())
            )
            await write_audit(
                conn,
                org_id=ctx.org_id,
                project_id=ctx.project_id,
                actor_user_id=ctx.user_id,
                action="run.started",
                resource_type="run",
                resource_id=run_id,
                via="orchestrator",
                data={
                    "key": run_key(ctx.project_key, ctx.story_number, ctx.run_id),
                    "workflow": ctx.workflow_name,
                    "engine": ctx.engine,
                },
            )
        started = now_ms()
        initial = {
            "vars": seed,
            "steps": [],
            "stepCount": 0,
            "tokenCount": 0,
            "startedAt": started,
            "pausedMs": 0,
            "lastActiveAt": started,
        }
        await _drive(rt, ctx, graph, initial)


async def resume_run(run_id: str, match: Callable[[dict[str, Any]], bool], value: Any) -> str:
    """Resume the interrupt whose payload satisfies `match` with `value`. Returns the run's status afterwards."""
    rt = runtime()
    async with rt.lock(run_id):
        async with read() as conn:
            ctx = await load_ctx(conn, run_id)
            status = (await conn.execute(sa.select(t.runs.c.status).where(t.runs.c.id == run_id))).scalar_one()
        if status in TERMINAL:
            raise conflict(f"This run is already {status}.")
        graph = _graph(rt, ctx)
        state = await graph.aget_state(_config(run_id))
        target = next((i for i in state.interrupts if isinstance(i.value, dict) and match(i.value)), None)
        if target is None:
            raise conflict("The run is not waiting for that step any more.")
        await _drive(rt, ctx, graph, Command(resume={target.id: value}))
        async with read() as conn:
            return str((await conn.execute(sa.select(t.runs.c.status).where(t.runs.c.id == run_id))).scalar_one())


async def continue_run(run_id: str) -> None:
    """Continue a run whose process died mid-step: replay from the last checkpoint."""
    rt = runtime()
    async with rt.lock(run_id):
        async with read() as conn:
            ctx = await load_ctx(conn, run_id)
        graph = _graph(rt, ctx)
        state = await graph.aget_state(_config(run_id))
        if not state.values:
            return
        if state.next and not state.interrupts:
            await _drive(rt, ctx, graph, None)
        else:
            await _settle(rt, ctx, graph)


async def cancel_run(run_id: str, actor_id: str | None, via: str, reason: str | None = None) -> None:
    rt = runtime()
    async with rt.lock(run_id):
        async with transaction() as conn:
            ctx = await load_ctx(conn, run_id)
            row = (
                await conn.execute(sa.select(t.runs.c.status).where(t.runs.c.id == run_id).with_for_update())
            ).first()
            if row is None or row.status in TERMINAL:
                return
            await conn.execute(
                t.runs.update()
                .where(t.runs.c.id == run_id)
                .values(
                    status="cancelled",
                    finished_at=sa.func.now(),
                    pending_approval=None,
                    updated_at=sa.func.now(),
                    error=reason,
                )
            )
            await conn.execute(
                t.run_steps.update()
                .where(t.run_steps.c.run_id == run_id, t.run_steps.c.status == "running")
                .values(status="skipped", finished_at=sa.func.now())
            )
            await _cancel_assignments(conn, run_id)
            await write_audit(
                conn,
                org_id=ctx.org_id,
                project_id=ctx.project_id,
                actor_user_id=actor_id,
                action="run.cancelled",
                resource_type="run",
                resource_id=run_id,
                via=via,
                data={
                    "key": run_key(ctx.project_key, ctx.story_number, ctx.run_id),
                    "workflow": ctx.workflow_name,
                    "before": row.status,
                    "reason": reason,
                },
            )
            await publish(conn, work_changed_run(ctx.project_key, ctx.story_number, run_id, actor_id))
            if ctx.user_id:
                await publish(
                    conn,
                    {
                        "type": "run.command",
                        "targetUserId": ctx.user_id,
                        "runId": run_id,
                        "command": "cancel",
                        "actorId": actor_id,
                    },
                )
        await rt.saver.adelete_thread(run_id)
    rt.wake(run_id)
    # Learnings from gates or rejected plans before the cancel are captured too (the gateway side is idempotent).
    rt.spawn(_notify_finished(rt, run_id), f"finished callback for {run_id}")


async def _drive(rt: Runtime, ctx: RunCtx, graph: CompiledStateGraph, graph_input: Any) -> None:
    config = _config(ctx.run_id)
    async with rt.pool.connection() as lock_conn:
        await lock_conn.execute("select pg_advisory_lock(%s)", (_advisory_key(ctx.run_id),))
        try:
            try:
                async for _chunk in graph.astream(graph_input, config, stream_mode="updates"):
                    state = await graph.aget_state(config)
                    await _persist(ctx, state.values, status="running", pending=None, publish_event=True)
                    rt.wake(ctx.run_id)
            except Exception as e:  # noqa: BLE001 — an unexpected error fails the run instead of leaving it running
                log.exception("Run %s failed while executing", ctx.run_id)
                await _finish(rt, ctx, graph, "failed", f"The orchestrator hit an error: {e}")
                return
            await _settle(rt, ctx, graph)
        finally:
            await lock_conn.execute("select pg_advisory_unlock(%s)", (_advisory_key(ctx.run_id),))


def _pending_approval(human: dict[str, Any]) -> dict[str, Any]:
    """The run's `pending_approval`: the question, plus what is being approved (an agent's plan or its output)."""
    plan = human.get("kind") == "agent-plan"
    pending: dict[str, Any] = {
        "stepId": human.get("stepId") or "",
        "question": str(human.get("question") or "Approve?"),
        "kind": "plan" if plan else "approval",
    }
    context = str((human.get("plan") if plan else human.get("context")) or "").strip()
    if context:
        pending["context"] = context[:20_000]
    if human.get("agentName"):
        pending["agentName"] = str(human["agentName"])
    return pending


async def _settle(rt: Runtime, ctx: RunCtx, graph: CompiledStateGraph) -> None:
    """Read the checkpoint (authoritative) and decide: waiting on people/harnesses, completed, or failed."""
    config = _config(ctx.run_id)
    state = await graph.aget_state(config)
    values = state.values or {}
    interrupts = [i for i in state.interrupts if isinstance(i.value, dict)]
    if interrupts:
        async with transaction() as conn:
            for i in interrupts:
                if i.value.get("kind") == "harness" and i.value.get("stepId"):
                    await conn.execute(
                        t.step_assignments.update()
                        .where(
                            t.step_assignments.c.run_id == ctx.run_id,
                            t.step_assignments.c.step_id == i.value["stepId"],
                            t.step_assignments.c.phase == i.value["phase"],
                        )
                        .values(interrupt_id=i.id)
                    )
        human = next((i.value for i in interrupts if i.value.get("kind") in ("agent-plan", "approval")), None)
        if human is not None:
            pending = _pending_approval(human)
            await _persist(ctx, values, status="awaiting_approval", pending=pending, publish_event=True)
        else:
            await _persist(ctx, values, status="running", pending=None, publish_event=True)
        rt.wake(ctx.run_id)
        return
    if state.next:
        # Work is still queued (the stream was cut short); the sweeper continues it.
        await _persist(ctx, values, status="running", pending=None, publish_event=True)
        return
    failure = (values.get("vars") or {}).get(RUN_FAILURE_KEY)
    await _finish(rt, ctx, graph, "failed" if failure else "completed", str(failure) if failure else None)


async def _finish(rt: Runtime, ctx: RunCtx, graph: CompiledStateGraph, status: str, error: str | None) -> None:
    state = await graph.aget_state(_config(ctx.run_id))
    values = state.values or {}
    async with transaction() as conn:
        current = (
            await conn.execute(sa.select(t.runs.c.status).where(t.runs.c.id == ctx.run_id).with_for_update())
        ).scalar_one()
        if current in TERMINAL:
            return
        await _persist(ctx, values, status=status, pending=None, publish_event=False, conn=conn, error=error)
        await _cancel_assignments(conn, ctx.run_id)
        await write_audit(
            conn,
            org_id=ctx.org_id,
            project_id=ctx.project_id,
            actor_user_id=ctx.user_id,
            action=f"run.{status}",
            resource_type="run",
            resource_id=ctx.run_id,
            via="orchestrator",
            data={
                "key": run_key(ctx.project_key, ctx.story_number, ctx.run_id),
                "workflow": ctx.workflow_name,
                "engine": ctx.engine,
                "files": len(await _current_changed_files(conn, ctx.run_id)),
                "error": error,
            },
        )
        await publish(conn, work_changed_run(ctx.project_key, ctx.story_number, ctx.run_id, None))
    await rt.saver.adelete_thread(ctx.run_id)
    rt.wake(ctx.run_id)
    rt.spawn(_notify_finished(rt, ctx.run_id), f"finished callback for {ctx.run_id}")


NOTIFY_BACKOFF_SECONDS = (0.0, 2.0, 5.0, 15.0)


async def _notify_finished(rt: Runtime, run_id: str, backoff: tuple[float, ...] = NOTIFY_BACKOFF_SECONDS) -> bool:
    """Tell the gateway, which captures run memory (idempotent) the same way it does for reported runs, and proposes a
    profile update. Retried briefly (a gateway restarting under `tsx watch`); once it answers, `finish_notified_at` is
    set. Until then the sweeper keeps re-notifying, so a callback lost to a restart is never lost for good."""
    last: str = ""
    for delay in backoff:
        if delay:
            await asyncio.sleep(delay)
        try:
            res = await rt.http.post(
                f"{rt.settings.API_URL}/internal/runs/{run_id}/finished",
                headers={"x-sdlc-internal-token": rt.settings.ORCHESTRATOR_TOKEN},
            )
            if res.status_code == 404:
                last = "the gateway does not know the run"
                break  # deleted since; nothing to capture
            res.raise_for_status()
        except httpx.HTTPError as e:
            last = str(e) or type(e).__name__
            continue
        async with transaction() as conn:
            await conn.execute(t.runs.update().where(t.runs.c.id == run_id).values(finish_notified_at=sa.func.now()))
        return True
    log.warning("Could not tell the gateway run %s finished (%s); the sweeper will try again", run_id, last)
    return False


async def _cancel_assignments(conn: AsyncConnection, run_id: str) -> None:
    await conn.execute(
        t.step_assignments.update()
        .where(t.step_assignments.c.run_id == run_id, t.step_assignments.c.status.in_(("pending", "delivered")))
        .values(status="cancelled")
    )


# ─── Mirroring state into runs / run_steps ─────────────────────────────────────────────────────────────────────


def _step_row(run_id: str, s: Step) -> dict[str, Any]:
    gate = s.get("gateDecision") or None
    return {
        "run_id": run_id,
        "step_id": s["id"],
        "seq": int(s.get("seq") or 0),
        "node_id": s.get("nodeId") or "",
        "kind": s.get("kind") or "",
        "label": s.get("label") or "",
        "status": s.get("status") or "running",
        "started_at": _dt(s.get("startedAt")),
        "finished_at": _dt(s.get("finishedAt")),
        "tokens_in": s.get("tokensIn"),
        "tokens_out": s.get("tokensOut"),
        "gate_pass": gate.get("pass") if gate else None,
        "gate_reason": _clip(gate.get("reason"), 2_000) if gate else None,
        "approval": s.get("approval"),
        "output": _clip(s.get("output"), MAX_OUTPUT),
        "plan": _clip(s.get("plan"), MAX_PLAN),
        "error": _clip(s.get("error"), 4_000),
        "changed_files": [str(p) for p in (s.get("changedFiles") or [])][:500],
        "evaluations": [],
        "report_url": gate.get("reportUrl") if gate else None,
        "agent_slug": s.get("agentSlug"),
        "agent_name": s.get("agentName"),
        "skills": list(s.get("skills") or []),
        "skills_used": list(s.get("skillsUsed") or []),
        "model": s.get("model"),
        "engine": s.get("engine"),
    }


def gate_evaluation_rows(run_id: str, steps: list[Step]) -> list[dict[str, Any]]:
    """One `run_evaluations` row per evaluator behind each decided gate (the stub gate is one `stub` evaluator)."""
    rows: list[dict[str, Any]] = []
    for s in steps:
        decision = s.get("gateDecision") or None
        if s.get("kind") != "gate" or not decision:
            continue
        base = {
            "run_id": run_id,
            "step_id": s["id"],
            "node_id": s.get("nodeId"),
            "step_label": s.get("label"),
            "report_url": decision.get("reportUrl"),
        }
        evaluators = [e for e in (decision.get("perEvaluator") or []) if isinstance(e, dict) and e.get("evaluator")]
        if not evaluators:
            source = str(decision.get("source") or "stub")
            evaluators = [
                {
                    "evaluator": source,
                    "pass": decision.get("pass"),
                    "reason": decision.get("reason"),
                    "required": True,
                    "source": source,
                }
            ]
        for e in evaluators:
            raw_counts = e.get("counts")
            counts: dict[str, Any] = raw_counts if isinstance(raw_counts, dict) else {}
            rows.append(
                {
                    **base,
                    "evaluator": str(e["evaluator"])[:200],
                    "score": e.get("score"),
                    "threshold": e.get("threshold"),
                    "pass": bool(e.get("pass")),
                    "required": e.get("required"),
                    "reason": _clip(e.get("reason"), 2_000),
                    "passed_count": counts.get("passed"),
                    "failed_count": counts.get("failed"),
                    "errored_count": counts.get("errored"),
                    "tokens_in": e.get("tokensIn"),
                    "tokens_out": e.get("tokensOut"),
                    "source": e.get("source") or decision.get("source"),
                    "eval_id": e.get("evalId"),
                    "eval_run_id": e.get("evalRunId"),
                    "details": e.get("details"),
                }
            )
    return rows


async def _persist_gate_evaluations(c: AsyncConnection, run_id: str, steps: list[Step]) -> None:
    rows = gate_evaluation_rows(run_id, steps)
    if not rows:
        return
    stmt = pg_insert(t.run_evaluations).values(rows)
    update_cols = {k: stmt.excluded[k] for k in rows[0] if k not in ("run_id", "step_id", "evaluator")}
    await c.execute(
        stmt.on_conflict_do_update(
            index_elements=[t.run_evaluations.c.run_id, t.run_evaluations.c.step_id, t.run_evaluations.c.evaluator],
            set_={**update_cols, "updated_at": sa.func.now()},
        )
    )


def merge_changed_files(current: list[str], steps: list[Step], *, exact_reported: bool = False) -> list[str] | None:
    """The run's changed files plus every step's, or None when there is nothing to write. VS Code's run-level report
    (through the gateway, `run_changes`) sets the exact list: once it exists the steps' union is not written back,
    or files the report dropped (reverted since a step changed them) would reappear. Before it, this fills in what the
    steps reported."""
    if exact_reported:
        return None
    step_files = {str(p) for s in steps for p in (s.get("changedFiles") or [])}
    if not step_files or step_files <= set(current):
        return None
    return sorted(set(current) | step_files)[:2000]


async def _current_changed_files(c: AsyncConnection, run_id: str) -> list[str]:
    files = (await c.execute(sa.select(t.runs.c.changed_files).where(t.runs.c.id == run_id))).scalar_one_or_none()
    return list(files or [])


async def _changes_reported(c: AsyncConnection, run_id: str) -> bool:
    """Whether VS Code reported the run's exact changes (the gateway's `run_changes` row)."""
    found = await c.execute(sa.select(t.run_changes.c.run_id).where(t.run_changes.c.run_id == run_id).limit(1))
    return found.first() is not None


async def _persist(
    ctx: RunCtx,
    values: dict[str, Any],
    *,
    status: str,
    pending: dict[str, Any] | None,
    publish_event: bool,
    conn: AsyncConnection | None = None,
    error: str | None = None,
) -> None:
    async def write(c: AsyncConnection) -> None:
        steps: list[Step] = list(values.get("steps") or [])
        if steps:
            rows = [_step_row(ctx.run_id, s) for s in steps]
            stmt = pg_insert(t.run_steps).values(rows)
            update_cols = {k: stmt.excluded[k] for k in rows[0] if k not in ("run_id", "step_id")}
            await c.execute(
                stmt.on_conflict_do_update(
                    index_elements=[t.run_steps.c.run_id, t.run_steps.c.step_id], set_=update_cols
                )
            )
            await _persist_gate_evaluations(c, ctx.run_id, steps)
        tokens_in = sum(int(s.get("tokensIn") or 0) for s in steps)
        tokens_out = sum(int(s.get("tokensOut") or 0) for s in steps)
        changes: dict[str, Any] = {
            "pending_approval": pending,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "updated_at": sa.func.now(),
            "status": status,
        }
        merged = (
            merge_changed_files(
                await _current_changed_files(c, ctx.run_id),
                steps,
                exact_reported=await _changes_reported(c, ctx.run_id),
            )
            if steps
            else None
        )
        if merged is not None:
            changes["changed_files"] = merged
        if status in TERMINAL:
            changes["finished_at"] = sa.func.now()
            changes["error"] = _clip(error, 4_000)
        await c.execute(
            t.runs.update().where(t.runs.c.id == ctx.run_id, t.runs.c.status.notin_(tuple(TERMINAL))).values(**changes)
        )
        if publish_event:
            await publish(c, work_changed_run(ctx.project_key, ctx.story_number, ctx.run_id, None))

    if conn is not None:
        await write(conn)
    else:
        async with transaction() as c:
            await write(c)
