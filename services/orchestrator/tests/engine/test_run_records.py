"""What the runner mirrors for each run's record: the files each step changed (reported when the harness finishes the
step), the run's merged file list, and one `run_evaluations` row per evaluator behind each gate."""

from __future__ import annotations

from typing import Any

from langgraph.types import Command

from app.engine.runner import _step_row, gate_evaluation_rows, merge_changed_files

from .test_run_graph import CONFIG, agent, answer, linear, make, pending, seed


async def test_a_finished_step_keeps_the_files_it_changed() -> None:
    graph, _, now = make(linear(agent("implement")))
    await graph.ainvoke(seed(now), CONFIG)
    await answer(graph, "harness", {"plan": "p"}, nodeId="implement", phase="plan")
    await answer(graph, "agent-plan", {"approve": True}, nodeId="implement")
    for i in await pending(graph):
        if i.value.get("phase") == "execute":
            result: dict[str, Any] = {"summary": "done", "skillsUsed": [], "changedFiles": ["src/a.ts", "src/b.ts"]}
            await graph.ainvoke(Command(resume={i.id: result}), CONFIG)
    step = (await graph.aget_state(CONFIG)).values["steps"][-1]
    assert step["changedFiles"] == ["src/a.ts", "src/b.ts"]
    assert _step_row("run-1", step)["changed_files"] == ["src/a.ts", "src/b.ts"]


def test_merging_step_files_into_the_run() -> None:
    steps: list[Any] = [{"changedFiles": ["b.ts", "a.ts"]}, {"changedFiles": ["c.ts"]}, {}]
    assert merge_changed_files([], steps) == ["a.ts", "b.ts", "c.ts"]
    assert merge_changed_files(["a.ts", "z.ts"], steps) == ["a.ts", "b.ts", "c.ts", "z.ts"]
    # Nothing new: leave VS Code's run-level list alone.
    assert merge_changed_files(["a.ts", "b.ts", "c.ts", "d.ts"], steps) is None
    assert merge_changed_files(["x.ts"], [{}]) is None


def test_an_exact_change_report_is_not_overwritten_by_the_steps() -> None:
    # VS Code reported the run's exact changes (b.ts was reverted after a step changed it): keep that list.
    steps: list[Any] = [{"changedFiles": ["a.ts", "b.ts"]}]
    assert merge_changed_files(["a.ts"], steps, exact_reported=True) is None
    assert merge_changed_files([], steps, exact_reported=True) is None


def test_gate_rows_one_per_evaluator_or_one_for_the_stub() -> None:
    stub: Any = {
        "id": "g1",
        "kind": "gate",
        "nodeId": "gate",
        "label": "Quality gate",
        "gateDecision": {"pass": False, "reason": "empty", "perEvaluator": [], "source": "stub"},
    }
    rows = gate_evaluation_rows("run-1", [stub, {"id": "a1", "kind": "agent"}])
    assert len(rows) == 1
    assert rows[0]["evaluator"] == "stub" and rows[0]["pass"] is False and rows[0]["reason"] == "empty"
    assert rows[0]["step_id"] == "g1" and rows[0]["step_label"] == "Quality gate"

    foundry: Any = {
        **stub,
        "gateDecision": {
            "pass": True,
            "reason": "ok",
            "source": "foundry",
            "reportUrl": "https://x",
            "perEvaluator": [
                {
                    "evaluator": "groundedness",
                    "score": 4.5,
                    "threshold": 3,
                    "pass": True,
                    "counts": {"passed": 9, "failed": 1},
                },
                {"evaluator": "relevance", "score": 2, "threshold": 3, "pass": False, "required": False},
            ],
        },
    }
    rows = gate_evaluation_rows("run-1", [foundry])
    assert [r["evaluator"] for r in rows] == ["groundedness", "relevance"]
    assert rows[0]["passed_count"] == 9 and rows[0]["report_url"] == "https://x" and rows[0]["source"] == "foundry"
    assert rows[1]["required"] is False
    # An undecided gate (still running) has no rows.
    assert gate_evaluation_rows("run-1", [{"id": "g2", "kind": "gate"}]) == []
