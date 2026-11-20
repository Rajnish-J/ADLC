"""Compiles a WorkflowSpec into a LangGraph StateGraph — every node the user puts on the canvas becomes LangGraph
node(s). Port of apps/extension/src/runtime/langgraph/specToStateGraph.ts, with one change: an agent step is not run
in-process but handed to a harness (Copilot, Claude Code, Codex, …) in the user's VS Code, and every wait on the
outside world is a durable `interrupt()` — so nothing is parked in memory between steps and a run survives a restart.

Node-id scheme (`:` is reserved in LangGraph node names, hence `__`):
  - `trigger` and `condition` are never nodes: the trigger is where START points, conditions compile to routers.
  - `end` compiles to END.
  - `agent` → `__plan_req` → `__plan_wait` → `__approve` → `__exec_req` → `__exec_wait`. A `_req` node records the
    step and the harness assignment; its `_wait` sibling only calls `interrupt()`, so replaying it on resume has no
    side effects. `__approve` is the human plan approval. With `requirePlanApproval: false` the node is just
    `__plan_req` (which hands the step out as `execute`) → `__exec_wait`.
  - `approval` → `__begin` → `__wait` (same reason).
  - `gate`, `set-variable`, `goto` → one node each.
Every exit is wired with conditional edges: a recorded failure (`RUN_FAILURE_KEY`) routes to END, otherwise the
spec's successors are resolved through IF / ELSE_IF / ELSE condition nodes.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import interrupt

from ..spec.models import RunBudget, WorkflowSpec
from .conditions import evaluate_condition
from .context import RunContext
from .graph import CONDITION_PRECEDENCE, find_trigger, parse_graph, spec_to_graph, successors
from .guards import BudgetExceededError, GuardState
from .state import RunGraphState, Step

RUN_FAILURE_KEY = "__runFailure__"
LAST_MESSAGE_KEY = "System.LastMessage.Text"

Update = dict[str, Any]


# ─── Dependencies the compiled graph calls out to ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AgentInfo:
    slug: str
    name: str
    instructions: str


class GateEvaluator(Protocol):
    async def evaluate(self, *, sdlc_step: str, output: str, query: str) -> dict[str, Any]:
        """Returns a GateDecision dict: {pass, reason, perEvaluator: [...], reportUrl?}."""
        ...


@dataclass
class CompileDeps:
    run_id: str
    budget: RunBudget
    # The harness unpinned agent steps run in (the one picked at Start).
    default_harness: str
    now: Callable[[], int]
    gate: GateEvaluator
    # Records a step's harness assignment (idempotent on (run, step, phase)) and tells the user's VS Code.
    assign: Callable[[Step, str, str, str, dict[str, Any]], Awaitable[None]]
    describe_agent: Callable[[str], Awaitable[AgentInfo | None]]
    describe_skills: Callable[[list[str]], Awaitable[list[dict[str, str]]]]


def harness_for(node_data: dict[str, Any], default_harness: str) -> str:
    """The harness an agent step runs in: its pinned harness, else the run's."""
    pinned = node_data.get("harness")
    return str(pinned) if pinned else default_harness


# ─── Per-node helpers (port of nodeHelpers.ts) ─────────────────────────────────────────────────────────────────


@dataclass
class Handle:
    ctx: RunContext
    guard: GuardState
    base_steps: int
    base_tokens: int


def _guard(state: RunGraphState, budget: RunBudget, now: Callable[[], int]) -> GuardState:
    return GuardState.from_state(budget, state, now)


def _reconstruct(state: RunGraphState, budget: RunBudget, now: Callable[[], int]) -> Handle:
    return Handle(
        ctx=RunContext(dict(state.get("vars") or {})),
        guard=_guard(state, budget, now),
        base_steps=state.get("stepCount", 0),
        base_tokens=state.get("tokenCount", 0),
    )


def begin_node(state: RunGraphState, budget: RunBudget, now: Callable[[], int]) -> Handle:
    """Reconstruct and tick once per logical spec node (raises BudgetExceededError on a breach)."""
    h = _reconstruct(state, budget, now)
    h.guard.tick(now())
    return h


def resume_node(state: RunGraphState, budget: RunBudget, now: Callable[[], int]) -> Handle:
    return _reconstruct(state, budget, now)


def pause_update(state: RunGraphState, now: Callable[[], int]) -> Update:
    resumed_at = now()
    last = state.get("lastActiveAt", 0)
    return {"pausedMs": max(0, resumed_at - last) if last > 0 else 0, "lastActiveAt": resumed_at}


def step_id_for(run_id: str, node_id: str, steps: list[Step]) -> str:
    prior = sum(1 for s in steps if s.get("nodeId") == node_id)
    return f"{run_id}-{node_id}-{prior + 1}"


def make_step(state: RunGraphState, run_id: str, node_id: str, kind: str, label: str, now: int) -> Step:
    steps = state.get("steps") or []
    return {
        "id": step_id_for(run_id, node_id, steps),
        "nodeId": node_id,
        "kind": kind,
        "label": label,
        "seq": 0,
        "status": "running",
        "startedAt": now,
    }


def finish_step(step: Step, status: str, now: int, error: str | None = None) -> Step:
    out = {**step, "status": status, "finishedAt": now}
    if error is not None:
        out["error"] = error
    return out


def find_running_step(state: RunGraphState, node_id: str) -> Step | None:
    for s in reversed(state.get("steps") or []):
        if s.get("nodeId") == node_id and s.get("status") == "running":
            return s
    return None


def to_update(h: Handle, steps: list[Step], now: Callable[[], int]) -> Update:
    return {
        "vars": h.ctx.to_bag(),
        "steps": steps,
        "stepCount": int(h.guard.step_count - h.base_steps),
        "tokenCount": int(h.guard.token_count - h.base_tokens),
        "lastActiveAt": now(),
    }


def fail_update(h: Handle, steps: list[Step], message: str, now: Callable[[], int]) -> Update:
    return {**to_update(h, steps, now), "vars": {**h.ctx.to_bag(), RUN_FAILURE_KEY: message}}


def _failed(state: RunGraphState) -> bool:
    return bool((state.get("vars") or {}).get(RUN_FAILURE_KEY))


def _seed_fields(ctx: RunContext) -> dict[str, Any]:
    out: dict[str, Any] = {}
    work_item = ctx.get("Local.WorkItem")
    if work_item:
        out["workItem"] = str(work_item)
    return out


# ─── Compiler ──────────────────────────────────────────────────────────────────────────────────────────────────


def _kind(node: Any) -> str:
    return str(node.data.get("kind"))


def compile_run_graph(spec: WorkflowSpec, deps: CompileDeps, checkpointer: BaseCheckpointSaver) -> CompiledStateGraph:
    raw = spec_to_graph(spec)
    graph = parse_graph(raw.nodes, raw.edges)
    trigger = find_trigger(graph)
    if trigger is None:
        raise ValueError(f'Workflow "{spec.name}" has no trigger node.')

    builder: StateGraph = StateGraph(RunGraphState)

    def entry_id(node: Any) -> str:
        kind = _kind(node)
        if kind == "end":
            return END
        if kind == "agent":
            return f"{node.id}__plan_req"
        if kind == "approval":
            return f"{node.id}__begin"
        return str(node.id)

    def exit_id(node: Any) -> str:
        kind = _kind(node)
        if kind == "agent":
            return f"{node.id}__exec_wait"
        if kind == "approval":
            return f"{node.id}__wait"
        return str(node.id)

    def resolve(source_id: str, ctx: RunContext, visited: frozenset[str] = frozenset()) -> list[str]:
        succs = successors(graph, source_id)
        conds = [s for s in succs if _kind(s) == "condition"]
        out = [entry_id(s) for s in succs if _kind(s) != "condition"]
        if conds:
            ordered = sorted(conds, key=lambda c: CONDITION_PRECEDENCE.get(str(c.data.get("branch") or "IF"), 0))
            winner = next((c for c in ordered if evaluate_condition(str(c.data.get("predicate") or ""), ctx)), None)
            if winner is not None and winner.id not in visited:
                out.extend(resolve(winner.id, ctx, visited | {winner.id}))
        return out

    def wire_outgoing(from_id: str, spec_source_id: str, extra: Callable[[], list[str]] | None = None) -> None:
        def route(state: RunGraphState) -> list[str] | str:
            if _failed(state):
                return END
            out = resolve(spec_source_id, RunContext(dict(state.get("vars") or {})))
            if extra:
                out.extend(extra())
            unique = list(dict.fromkeys(out))
            return unique if unique else END

        builder.add_conditional_edges(from_id, route)

    def end_on_failure(next_id: str) -> Callable[[RunGraphState], str]:
        return lambda state: END if _failed(state) else next_id

    for node in graph.nodes.values():
        kind = _kind(node)
        if kind in ("trigger", "condition", "end"):
            continue
        label = str(node.data.get("label") or node.id)
        data: dict[str, Any] = dict(node.data)

        if kind == "agent":
            _add_agent(builder, node.id, label, data, deps)
            if not requires_plan_approval(data):
                # No plan phase: `__plan_req` hands the step straight out as `execute`.
                builder.add_conditional_edges(f"{node.id}__plan_req", end_on_failure(f"{node.id}__exec_wait"))
                continue
            builder.add_conditional_edges(f"{node.id}__plan_req", end_on_failure(f"{node.id}__plan_wait"))
            builder.add_conditional_edges(f"{node.id}__plan_wait", end_on_failure(f"{node.id}__approve"))
            builder.add_conditional_edges(f"{node.id}__approve", end_on_failure(f"{node.id}__exec_req"))
            builder.add_conditional_edges(f"{node.id}__exec_req", end_on_failure(f"{node.id}__exec_wait"))
            continue
        if kind == "approval":
            _add_approval(builder, node.id, label, data, deps)
            builder.add_edge(f"{node.id}__begin", f"{node.id}__wait")
            continue
        if kind == "gate":
            _add_gate(builder, node.id, label, data, deps)
            continue
        if kind == "set-variable":
            _add_set_variable(builder, node.id, label, data, deps)
            continue
        if kind == "goto":
            _add_goto(builder, node.id, label, deps)
            continue

    wire_outgoing(START, trigger.id)
    for node in graph.nodes.values():
        kind = _kind(node)
        if kind in ("trigger", "condition", "end"):
            continue
        extra = None
        if kind == "goto":
            target_id = str(node.data.get("targetId") or "")
            target = graph.nodes.get(target_id) if target_id else None

            def _extra(target: Any = target) -> list[str]:
                return [entry_id(target)] if target is not None else []

            extra = _extra
        wire_outgoing(exit_id(node), node.id, extra)

    return builder.compile(checkpointer=checkpointer)


# ─── Node kinds ────────────────────────────────────────────────────────────────────────────────────────────────


def requires_plan_approval(data: dict[str, Any]) -> bool:
    """Whether an agent node plans first and waits for a person to approve it. On unless the node opts out."""
    return data.get("requirePlanApproval") is not False


def _add_agent(builder: StateGraph, node_id: str, label: str, data: dict[str, Any], deps: CompileDeps) -> None:
    run_id, budget, now = deps.run_id, deps.budget, deps.now
    plan_first = requires_plan_approval(data)
    agent_slug = str(data.get("agentId") or "")
    agent_name = str(data.get("agentName") or label)
    skills = [str(s) for s in (data.get("skills") or [])]
    harness = harness_for(data, deps.default_harness)
    output_var = str(data.get("outputVar") or "")

    async def assignment(step: Step, ctx: RunContext, phase: str, approved_plan: str | None) -> dict[str, Any]:
        agent = await deps.describe_agent(agent_slug) if agent_slug else None
        payload: dict[str, Any] = {
            "action": phase,
            "stepId": step["id"],
            "nodeId": node_id,
            "agentId": agent_slug,
            "agentName": agent.name if agent else agent_name,
            "instructions": ctx.get_last_message(),
            "skills": await deps.describe_skills(skills) if skills else [],
            "harness": harness,
            **_seed_fields(ctx),
        }
        if agent and agent.instructions:
            payload["agentInstructions"] = agent.instructions
        if approved_plan:
            payload["approvedPlan"] = approved_plan
        return payload

    async def plan_req(state: RunGraphState) -> Update:
        h = _reconstruct(state, budget, now)
        step = make_step(state, run_id, node_id, "agent", label, now())
        step.update({"agentSlug": agent_slug or None, "agentName": agent_name, "skills": skills, "engine": harness})
        try:
            h.guard.tick(now())
            phase = "plan" if plan_first else "execute"
            await deps.assign(step, node_id, phase, harness, await assignment(step, h.ctx, phase, None))
            return to_update(h, [step], now)
        except BudgetExceededError as e:
            return fail_update(h, [finish_step(step, "failed", now(), str(e))], str(e), now)
        except Exception as e:  # noqa: BLE001 — a failed hand-off fails the run gracefully, keeping the step record
            message = f'Agent "{agent_name}" could not be handed to {harness}: {e}'
            return fail_update(h, [finish_step(step, "failed", now(), message)], message, now)

    async def plan_wait(state: RunGraphState) -> Update:
        prior = find_running_step(state, node_id)
        result = interrupt(
            {
                "kind": "harness",
                "phase": "plan",
                "nodeId": node_id,
                "stepId": prior["id"] if prior else None,
                "harness": harness,
                "agentId": agent_slug,
                "agentName": agent_name,
            }
        )
        h = resume_node(state, budget, now)
        if not prior:
            return to_update(h, [], now)
        tokens_in, tokens_out = int(result.get("tokensIn") or 0), int(result.get("tokensOut") or 0)
        try:
            h.guard.add_tokens(tokens_in, tokens_out)
        except BudgetExceededError as e:
            return fail_update(h, [finish_step(prior, "failed", now(), str(e))], str(e), now)
        step = {**prior, "plan": str(result.get("plan") or ""), "tokensIn": tokens_in, "tokensOut": tokens_out}
        return to_update(h, [step], now)

    async def approve(state: RunGraphState) -> Update:
        prior = find_running_step(state, node_id)
        decision = interrupt(
            {
                "kind": "agent-plan",
                "nodeId": node_id,
                "stepId": prior["id"] if prior else None,
                "agentId": agent_slug,
                "agentName": agent_name,
                "plan": (prior or {}).get("plan", ""),
                "question": f'Approve {agent_name}\'s plan for "{label}"?',
            }
        )
        h = resume_node(state, budget, now)
        pause = pause_update(state, now)
        record = _approval_record(decision)
        if not decision.get("approve"):
            message = f'Agent "{agent_name}" plan rejected by {decision.get("actor")}' + (
                f": {decision['comment']}" if decision.get("comment") else ""
            )
            steps = [finish_step({**prior, "output": message, "approval": record}, "blocked", now())] if prior else []
            return {**pause, "vars": {**h.ctx.to_bag(), RUN_FAILURE_KEY: message}, "steps": steps}
        return {**pause, "steps": [{**prior, "approval": record}] if prior else []}

    async def exec_req(state: RunGraphState) -> Update:
        h = resume_node(state, budget, now)
        prior = find_running_step(state, node_id)
        if not prior:
            message = f'Agent "{agent_name}" lost its step record.'
            return {"vars": {**h.ctx.to_bag(), RUN_FAILURE_KEY: message}}
        try:
            payload = await assignment(prior, h.ctx, "execute", prior.get("plan"))
            await deps.assign(prior, node_id, "execute", harness, payload)
        except Exception as e:  # noqa: BLE001
            message = f'Agent "{agent_name}" could not be handed to {harness}: {e}'
            return fail_update(h, [finish_step(prior, "failed", now(), message)], message, now)
        return {"lastActiveAt": now()}

    async def exec_wait(state: RunGraphState) -> Update:
        prior = find_running_step(state, node_id)
        result = interrupt(
            {
                "kind": "harness",
                "phase": "execute",
                "nodeId": node_id,
                "stepId": prior["id"] if prior else None,
                "harness": harness,
                "agentId": agent_slug,
                "agentName": agent_name,
            }
        )
        h = resume_node(state, budget, now)
        base = prior or make_step(state, run_id, node_id, "agent", label, now())
        summary = str(result.get("summary") or "")
        tokens_in = int(base.get("tokensIn") or 0) + int(result.get("tokensIn") or 0)
        tokens_out = int(base.get("tokensOut") or 0) + int(result.get("tokensOut") or 0)
        try:
            h.guard.add_tokens(int(result.get("tokensIn") or 0), int(result.get("tokensOut") or 0))
        except BudgetExceededError as e:
            return fail_update(h, [finish_step(base, "failed", now(), str(e))], str(e), now)
        h.ctx.set_last_message(summary)
        if output_var:
            h.ctx.set(output_var, summary)
        for k, v in (result.get("outputs") or {}).items():
            h.ctx.set(str(k), v)
        done = finish_step(
            {
                **base,
                "output": summary,
                "tokensIn": tokens_in,
                "tokensOut": tokens_out,
                "skillsUsed": [{"slug": s, "evidence": "declared"} for s in (result.get("skillsUsed") or [])],
                "model": result.get("model"),
                "changedFiles": [str(p) for p in (result.get("changedFiles") or [])][:500],
            },
            "succeeded",
            now(),
        )
        return to_update(h, [done], now)

    builder.add_node(f"{node_id}__plan_req", plan_req)
    if plan_first:
        builder.add_node(f"{node_id}__plan_wait", plan_wait)
        builder.add_node(f"{node_id}__approve", approve)
        builder.add_node(f"{node_id}__exec_req", exec_req)
    builder.add_node(f"{node_id}__exec_wait", exec_wait)


def _approval_record(decision: dict[str, Any]) -> dict[str, Any]:
    record: dict[str, Any] = {"approve": bool(decision.get("approve"))}
    if decision.get("comment"):
        record["comment"] = str(decision["comment"])
    if decision.get("actor"):
        record["actor"] = str(decision["actor"])
    return record


def _latest_agent_result(state: RunGraphState) -> tuple[str, str] | None:
    """The newest finished agent step's name and output (falling back to its plan): what an approval node asks about."""
    for s in reversed(state.get("steps") or []):
        if s.get("kind") != "agent" or s.get("status") != "succeeded":
            continue
        text = str(s.get("output") or s.get("plan") or "").strip()
        if text:
            return str(s.get("agentName") or s.get("label") or "Agent"), text[:20_000]
    return None


def _add_approval(builder: StateGraph, node_id: str, label: str, data: dict[str, Any], deps: CompileDeps) -> None:
    run_id, budget, now = deps.run_id, deps.budget, deps.now

    async def begin(state: RunGraphState) -> Update:
        h = _reconstruct(state, budget, now)
        step = make_step(state, run_id, node_id, "approval", label, now())
        try:
            h.guard.tick(now())
        except BudgetExceededError as e:
            return fail_update(h, [finish_step(step, "failed", now(), str(e))], str(e), now)
        return to_update(h, [step], now)

    async def wait(state: RunGraphState) -> Update:
        prior = find_running_step(state, node_id)
        payload: dict[str, Any] = {
            "kind": "approval",
            "nodeId": node_id,
            "stepId": prior["id"] if prior else None,
            "question": str(data.get("question") or "Approve to continue?"),
        }
        # What the person is approving: the latest agent step's output (or its plan, when it has no output yet).
        source = _latest_agent_result(state)
        if source:
            payload["agentName"], payload["context"] = source
        if data.get("approvalDefault"):
            payload["default"] = str(data["approvalDefault"])
        decision = interrupt(payload)
        h = resume_node(state, budget, now)
        pause = pause_update(state, now)
        record = _approval_record(decision)
        if not decision.get("approve"):
            message = f"Approval rejected by {decision.get('actor')}" + (
                f": {decision['comment']}" if decision.get("comment") else ""
            )
            steps = [finish_step({**prior, "output": message, "approval": record}, "blocked", now())] if prior else []
            return {**pause, "vars": {**h.ctx.to_bag(), RUN_FAILURE_KEY: message}, "steps": steps}
        approval_var = str(data.get("approvalVar") or "")
        if approval_var:
            h.ctx.set(approval_var, "yes")
        steps = (
            [
                finish_step(
                    {**prior, "output": f"approved by {decision.get('actor')}", "approval": record}, "succeeded", now()
                )
            ]
            if prior
            else []
        )
        return {**pause, "vars": h.ctx.to_bag(), "steps": steps}

    builder.add_node(f"{node_id}__begin", begin)
    builder.add_node(f"{node_id}__wait", wait)


def _add_gate(builder: StateGraph, node_id: str, label: str, data: dict[str, Any], deps: CompileDeps) -> None:
    run_id, budget, now = deps.run_id, deps.budget, deps.now
    gate_step = str(data.get("gateStep") or "implement")
    result_var = str(data.get("gateResultVar") or "")

    async def gate(state: RunGraphState) -> Update:
        h = _reconstruct(state, budget, now)
        step = make_step(state, run_id, node_id, "gate", label, now())
        try:
            h.guard.tick(now())
        except BudgetExceededError as e:
            return fail_update(h, [finish_step(step, "failed", now(), str(e))], str(e), now)
        decision = await deps.gate.evaluate(
            sdlc_step=gate_step, output=h.ctx.get_last_message(), query=str(h.ctx.get("Local.WorkItem") or "")
        )
        if result_var:
            h.ctx.set(f"{result_var}.pass", bool(decision.get("pass")))
        reason = str(decision.get("reason") or "")
        if not decision.get("pass"):
            done = finish_step({**step, "gateDecision": decision}, "blocked", now(), reason)
            return fail_update(h, [done], f"Gate ({gate_step}) blocked the run: {reason}", now)
        # A pass is not an error: its reason is the step's output.
        return to_update(
            h, [finish_step({**step, "gateDecision": decision, "output": reason}, "succeeded", now())], now
        )

    builder.add_node(node_id, gate)


def _add_set_variable(builder: StateGraph, node_id: str, label: str, data: dict[str, Any], deps: CompileDeps) -> None:
    run_id, budget, now = deps.run_id, deps.budget, deps.now
    variable = str(data.get("variable") or "")

    async def set_variable(state: RunGraphState) -> Update:
        h = _reconstruct(state, budget, now)
        step = make_step(state, run_id, node_id, "set-variable", label, now())
        try:
            h.guard.tick(now())
        except BudgetExceededError as e:
            return fail_update(h, [finish_step(step, "failed", now(), str(e))], str(e), now)
        if variable:
            h.ctx.set(variable, h.ctx.interpolate(data.get("value")))
        return to_update(h, [finish_step(step, "succeeded", now())], now)

    builder.add_node(node_id, set_variable)


def _add_goto(builder: StateGraph, node_id: str, label: str, deps: CompileDeps) -> None:
    run_id, budget, now = deps.run_id, deps.budget, deps.now

    async def goto(state: RunGraphState) -> Update:
        h = _reconstruct(state, budget, now)
        step = make_step(state, run_id, node_id, "goto", label, now())
        try:
            h.guard.tick(now())
        except BudgetExceededError as e:
            return fail_update(h, [finish_step(step, "failed", now(), str(e))], str(e), now)
        return to_update(h, [finish_step(step, "succeeded", now())], now)

    builder.add_node(node_id, goto)
