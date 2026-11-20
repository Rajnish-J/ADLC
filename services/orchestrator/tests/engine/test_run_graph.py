"""The compiled run graph, end to end, with an in-memory checkpointer and a fake harness: every agent step is handed
out, planned, approved and executed through interrupts, exactly as the runner drives it against Postgres."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from app.engine.compiler import RUN_FAILURE_KEY, AgentInfo, CompileDeps, compile_run_graph
from app.gates.stub import StubGateEvaluator
from app.spec.models import RunBudget, parse_spec

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


class FakeHarnesses:
    def __init__(self) -> None:
        self.assigned: list[tuple[str, str, str, dict[str, Any]]] = []  # (node, phase, harness, payload)

    async def assign(
        self, step: dict[str, Any], node_id: str, phase: str, harness: str, payload: dict[str, Any]
    ) -> None:
        self.assigned.append((node_id, phase, harness, payload))


def make(spec_raw: dict[str, Any], *, default_harness: str = "claude-code", max_steps: int = 50):
    clock = {"t": 1_000}

    def now() -> int:
        clock["t"] += 10
        return clock["t"]

    harnesses = FakeHarnesses()

    async def describe_agent(slug: str) -> AgentInfo | None:
        return AgentInfo(slug=slug, name=slug.title(), instructions=f"You are the {slug}.")

    async def describe_skills(slugs: list[str]) -> list[dict[str, str]]:
        return [{"slug": s, "name": s.title()} for s in slugs]

    deps = CompileDeps(
        run_id="run-1",
        budget=RunBudget(maxSteps=max_steps, timeoutMs=60 * 60_000, maxTokens=0),
        default_harness=default_harness,
        now=now,
        gate=StubGateEvaluator(),
        assign=harnesses.assign,
        describe_agent=describe_agent,
        describe_skills=describe_skills,
    )
    graph = compile_run_graph(parse_spec(spec_raw), deps, InMemorySaver())
    return graph, harnesses, now


CONFIG = {"configurable": {"thread_id": "run-1"}, "recursion_limit": 1_000}


def seed(now: Any, text: str = "PAY-1: Add refunds") -> dict[str, Any]:
    t = now()
    return {
        "vars": {"System.LastMessage.Text": text, "Local.WorkItem": text},
        "steps": [],
        "stepCount": 0,
        "tokenCount": 0,
        "startedAt": t,
        "pausedMs": 0,
        "lastActiveAt": t,
    }


async def pending(graph: Any) -> list[Any]:
    state = await graph.aget_state(CONFIG)
    return [i for i in state.interrupts]


async def answer(graph: Any, kind: str, value: Any, **match: Any) -> None:
    for i in await pending(graph):
        v = i.value
        if v.get("kind") == kind and all(v.get(k) == m for k, m in match.items()):
            await graph.ainvoke(Command(resume={i.id: value}), CONFIG)
            return
    raise AssertionError(f"No {kind} interrupt matching {match}: {[i.value for i in await pending(graph)]}")


async def drive_agent(
    graph: Any, node_id: str, *, outputs: dict[str, Any] | None = None, summary: str = "done"
) -> None:
    await answer(graph, "harness", {"plan": f"plan for {node_id}"}, nodeId=node_id, phase="plan")
    await answer(graph, "agent-plan", {"approve": True, "actor": "lead@x"}, nodeId=node_id)
    await answer(
        graph,
        "harness",
        {"summary": f"{summary} {node_id}", "skillsUsed": [], "outputs": outputs or {}},
        nodeId=node_id,
        phase="execute",
    )


def linear(*nodes: dict[str, Any]) -> dict[str, Any]:
    all_nodes = [
        {"id": "start", "kind": "trigger", "label": "Start", "data": {}},
        *nodes,
        {"id": "end", "kind": "end", "label": "End", "data": {}},
    ]
    edges = [{"source": a["id"], "target": b["id"]} for a, b in zip(all_nodes, all_nodes[1:], strict=False)]
    return {
        "specVersion": 1,
        "name": "T",
        "description": "",
        "pattern": "sequential",
        "nodes": all_nodes,
        "edges": edges,
        "budget": {"maxSteps": 50, "timeoutMs": 300000, "maxTokens": 0},
    }


def agent(node_id: str, **data: Any) -> dict[str, Any]:
    return {"id": node_id, "kind": "agent", "label": node_id.title(), "data": {"agentId": node_id, **data}}


async def test_story_delivery_runs_every_node_as_a_langgraph_node() -> None:
    spec = json.loads((FIXTURES / "story_delivery.json").read_text(encoding="utf-8"))
    graph, harnesses, now = make(spec)
    await graph.ainvoke(seed(now), CONFIG)

    await drive_agent(graph, "plan")
    await answer(graph, "approval", {"approve": True, "actor": "lead@x"}, nodeId="approve-plan")
    await drive_agent(graph, "implement")
    await drive_agent(graph, "test")  # the stub gate passes: the output has no "fail"
    await drive_agent(graph, "review")
    await drive_agent(graph, "pr-description")
    await answer(graph, "approval", {"approve": True, "actor": "lead@x"}, nodeId="merge-approval")

    state = await graph.aget_state(CONFIG)
    assert not state.next and not state.interrupts
    steps = state.values["steps"]
    assert [s["nodeId"] for s in steps] == [
        "plan",
        "approve-plan",
        "implement",
        "test",
        "quality-gate",
        "review",
        "pr-description",
        "merge-approval",
    ]
    assert all(s["status"] == "succeeded" for s in steps)
    assert [s["seq"] for s in steps] == list(range(1, 9))
    assert RUN_FAILURE_KEY not in state.values["vars"]
    # Each agent step was handed out twice (plan, then execute) to the run's harness, with the prior output.
    agent_nodes = ["plan", "implement", "test", "review", "pr-description"]
    assert [(n, p) for n, p, _, _ in harnesses.assigned] == [(n, p) for n in agent_nodes for p in ("plan", "execute")]
    assert {h for _, _, h, _ in harnesses.assigned} == {"claude-code"}
    implement_exec = next(p for n, ph, _, p in harnesses.assigned if n == "implement" and ph == "execute")
    assert implement_exec["approvedPlan"] == "plan for implement"
    assert implement_exec["instructions"] == "done plan"
    assert implement_exec["agentInstructions"] == "You are the implementer."


async def test_each_step_goes_to_its_pinned_harness() -> None:
    spec = linear(agent("plan", harness="claude-code"), agent("implement", harness="copilot"), agent("review"))
    graph, harnesses, now = make(spec, default_harness="codex")
    await graph.ainvoke(seed(now), CONFIG)
    for node in ("plan", "implement", "review"):
        await drive_agent(graph, node)
    by_node = {n: h for n, _, h, _ in harnesses.assigned}
    assert by_node == {"plan": "claude-code", "implement": "copilot", "review": "codex"}
    steps = (await graph.aget_state(CONFIG)).values["steps"]
    assert [s["engine"] for s in steps] == ["claude-code", "copilot", "codex"]


async def test_rejecting_a_plan_blocks_the_step_and_fails_the_run() -> None:
    graph, harnesses, now = make(linear(agent("plan"), agent("implement")))
    await graph.ainvoke(seed(now), CONFIG)
    await answer(graph, "harness", {"plan": "risky plan"}, nodeId="plan", phase="plan")
    await answer(graph, "agent-plan", {"approve": False, "actor": "lead@x", "comment": "too risky"}, nodeId="plan")
    state = await graph.aget_state(CONFIG)
    assert not state.next
    assert state.values["vars"][RUN_FAILURE_KEY] == 'Agent "Plan" plan rejected by lead@x: too risky'
    [step] = state.values["steps"]
    assert step["status"] == "blocked"
    assert step["approval"] == {"approve": False, "comment": "too risky", "actor": "lead@x"}
    assert [n for n, _, _, _ in harnesses.assigned] == ["plan"]  # implement never handed out


async def test_condition_branches_on_variables_a_harness_set() -> None:
    spec = {
        "specVersion": 1,
        "name": "Branch",
        "description": "",
        "pattern": "sequential",
        "budget": {"maxSteps": 50, "timeoutMs": 300000, "maxTokens": 0},
        "nodes": [
            {"id": "start", "kind": "trigger", "label": "Start", "data": {}},
            agent("test"),
            {
                "id": "if-pass",
                "kind": "condition",
                "label": "Passed",
                "data": {"branch": "IF", "predicate": "=Local.TestsPassed == true"},
            },
            {"id": "else", "kind": "condition", "label": "Else", "data": {"branch": "ELSE", "predicate": ""}},
            agent("release"),
            agent("fix"),
            {"id": "end", "kind": "end", "label": "End", "data": {}},
        ],
        "edges": [
            {"source": "start", "target": "test"},
            {"source": "test", "target": "if-pass"},
            {"source": "test", "target": "else"},
            {"source": "if-pass", "target": "release"},
            {"source": "else", "target": "fix"},
            {"source": "release", "target": "end"},
            {"source": "fix", "target": "end"},
        ],
    }
    graph, harnesses, now = make(spec)
    await graph.ainvoke(seed(now), CONFIG)
    await drive_agent(graph, "test", outputs={"Local.TestsPassed": True})
    await drive_agent(graph, "release")
    state = await graph.aget_state(CONFIG)
    assert not state.next
    assert [s["nodeId"] for s in state.values["steps"]] == ["test", "release"]


async def test_goto_loops_until_the_step_budget_stops_it() -> None:
    spec = {
        "specVersion": 1,
        "name": "Loop",
        "description": "",
        "pattern": "sequential",
        "budget": {"maxSteps": 4, "timeoutMs": 300000, "maxTokens": 0},
        "nodes": [
            {"id": "start", "kind": "trigger", "label": "Start", "data": {}},
            {"id": "count", "kind": "set-variable", "label": "Count", "data": {"variable": "Local.N", "value": "x"}},
            {"id": "again", "kind": "goto", "label": "Again", "data": {"targetId": "count"}},
        ],
        "edges": [{"source": "start", "target": "count"}, {"source": "count", "target": "again"}],
    }
    graph, _, now = make(spec, max_steps=4)
    await graph.ainvoke(seed(now), CONFIG)
    state = await graph.aget_state(CONFIG)
    assert not state.next
    assert "Halted after 4 node executions" in str(state.values["vars"][RUN_FAILURE_KEY])
    assert state.values["stepCount"] >= 4  # the breaching tick is counted too
    ids = [s["id"] for s in state.values["steps"]]
    assert len(ids) == len(set(ids))  # re-entering a node gets a fresh step id


async def test_a_failing_gate_blocks_the_run() -> None:
    spec = linear(
        agent("implement"),
        {"id": "gate", "kind": "gate", "label": "Gate", "data": {"gateStep": "implement"}},
        agent("review"),
    )
    graph, harnesses, now = make(spec)
    await graph.ainvoke(seed(now), CONFIG)
    await drive_agent(graph, "implement", summary="tests fail")
    state = await graph.aget_state(CONFIG)
    assert not state.next
    gate = state.values["steps"][-1]
    assert gate["kind"] == "gate" and gate["status"] == "blocked"
    assert gate["gateDecision"]["source"] == "stub"
    assert [n for n, _, _, _ in harnesses.assigned].count("review") == 0


@pytest.mark.parametrize("approve", [True, False])
async def test_parallel_branches_resume_independently(approve: bool) -> None:
    spec = {
        "specVersion": 1,
        "name": "Fan",
        "description": "",
        "pattern": "sequential",
        "budget": {"maxSteps": 50, "timeoutMs": 300000, "maxTokens": 0},
        "nodes": [
            {"id": "start", "kind": "trigger", "label": "Start", "data": {}},
            agent("docs", harness="copilot"),
            agent("tests", harness="claude-code"),
            {"id": "end", "kind": "end", "label": "End", "data": {}},
        ],
        "edges": [
            {"source": "start", "target": "docs"},
            {"source": "start", "target": "tests"},
            {"source": "docs", "target": "end"},
            {"source": "tests", "target": "end"},
        ],
    }
    graph, harnesses, now = make(spec)
    await graph.ainvoke(seed(now), CONFIG)
    assert {(n, h) for n, _, h, _ in harnesses.assigned} == {("docs", "copilot"), ("tests", "claude-code")}
    # Branches advance superstep by superstep (LangGraph's model), so each phase is answered for both; within a
    # superstep, interrupts resume by id in any order.
    await answer(graph, "harness", {"plan": "p"}, nodeId="tests", phase="plan")
    await answer(graph, "harness", {"plan": "p"}, nodeId="docs", phase="plan")
    await answer(graph, "agent-plan", {"approve": True, "actor": "a"}, nodeId="tests")
    await answer(graph, "agent-plan", {"approve": approve, "actor": "a"}, nodeId="docs")
    state = await graph.aget_state(CONFIG)
    if approve:
        await answer(graph, "harness", {"summary": "ok"}, nodeId="docs", phase="execute")
        await answer(graph, "harness", {"summary": "ok"}, nodeId="tests", phase="execute")
        state = await graph.aget_state(CONFIG)
        assert not state.next and RUN_FAILURE_KEY not in state.values["vars"]
        assert sorted(s["nodeId"] for s in state.values["steps"]) == ["docs", "tests"]
    else:
        assert not state.next and RUN_FAILURE_KEY in state.values["vars"]


async def test_an_agent_without_plan_approval_is_handed_out_to_execute_straight_away() -> None:
    graph, harnesses, now = make(linear(agent("test", requirePlanApproval=False)))
    await graph.ainvoke(seed(now), CONFIG)

    [i] = await pending(graph)
    assert i.value["kind"] == "harness" and i.value["phase"] == "execute"
    assert [(n, p) for n, p, _, _ in harnesses.assigned] == [("test", "execute")]
    assert "approvedPlan" not in harnesses.assigned[0][3]

    await answer(graph, "harness", {"summary": "All green", "skillsUsed": []}, nodeId="test", phase="execute")
    state = await graph.aget_state(CONFIG)
    assert not state.next and not state.interrupts
    [step] = state.values["steps"]
    assert step["status"] == "succeeded" and step["output"] == "All green"


async def test_an_approval_node_carries_the_latest_agent_output() -> None:
    approval = {"id": "ok", "kind": "approval", "label": "Ok?", "data": {"question": "Ship it?"}}
    graph, _, now = make(linear(agent("plan"), approval))
    await graph.ainvoke(seed(now), CONFIG)
    await drive_agent(graph, "plan", summary="the plan is")

    [i] = await pending(graph)
    assert i.value["kind"] == "approval"
    assert i.value["context"] == "the plan is plan"
    assert i.value["agentName"] == "Plan"


async def test_a_tester_report_with_no_failures_passes_the_gate() -> None:
    gate = {"id": "gate", "kind": "gate", "label": "Quality gate", "data": {}}
    graph, _, now = make(linear(agent("test", requirePlanApproval=False), gate))
    await graph.ainvoke(seed(now), CONFIG)
    report = "## Suite\n- 12 passed, 0 failed\n\n## Failures\n- none\n"
    await answer(graph, "harness", {"summary": report, "skillsUsed": []}, nodeId="test", phase="execute")

    state = await graph.aget_state(CONFIG)
    assert not state.interrupts and not state.next
    gate_step = state.values["steps"][-1]
    assert gate_step["status"] == "succeeded"
    assert "error" not in gate_step and "only checked for failures" in gate_step["output"]
    assert RUN_FAILURE_KEY not in state.values["vars"]
