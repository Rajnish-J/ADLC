import pytest

from app.engine.context import RunContext
from app.engine.graph import (
    CONDITION_PRECEDENCE,
    KIND_TO_TYPE,
    WorkflowEdge,
    WorkflowNode,
    find_trigger,
    kind_of,
    parse_graph,
    resolve_successors,
    spec_to_graph,
    successors,
)
from app.engine.guards import BudgetExceededError, GuardState
from app.spec.models import parse_spec
from tests.fixtures import load_story_delivery

END = "__end__"


def entry_id(node: WorkflowNode) -> str:
    """The compiler's LangGraph entry-id scheme (specToStateGraph.ts `entryId`)."""
    kind = kind_of(node)
    if kind == "end":
        return END
    if kind == "agent":
        return f"{node.id}__plan"
    if kind == "approval":
        return f"{node.id}__begin"
    return node.id


def graph_of(spec):
    g = spec_to_graph(spec)
    return parse_graph(g.nodes, g.edges)


def spec(nodes, edges, **extra):
    return {
        "specVersion": 1,
        "name": "demo",
        "description": "",
        "pattern": "sequential",
        "nodes": nodes,
        "edges": [{"source": s, "target": t} for s, t in edges],
        "budget": {"maxSteps": 50, "timeoutMs": 300000, "maxTokens": 0},
        **extra,
    }


def n(id, kind, label=None, **data):
    return {"id": id, "kind": kind, "label": label or id, "data": data}


def sequential_two_agents():
    """internalAgentToSpec([A, B], { name: 'demo' }) — agents gated at 'implement'."""
    nodes = [
        n("trigger", "trigger", "Start"),
        n("agent_0", "agent", "A", agentId="a", agentName="A", sdlcStep="implement", outputVar="Local.AOutput"),
        n("gate_0", "gate", "Gate: implement", gateStep="implement", gateResultVar="Local.Gate0Result"),
        n("agent_1", "agent", "B", agentId="b", agentName="B", sdlcStep="implement", outputVar="Local.BOutput"),
        n("gate_1", "gate", "Gate: implement", gateStep="implement", gateResultVar="Local.Gate1Result"),
        n("end", "end", "Done"),
    ]
    edges = [
        ("agent_0", "gate_0"),
        ("agent_1", "gate_1"),
        ("trigger", "agent_0"),
        ("gate_0", "agent_1"),
        ("gate_1", "end"),
    ]
    return spec(nodes, edges)


def handoff_router():
    """internalAgentToSpec([Router, FeaturePath, BugPath], { pattern: 'handoff', gateAfterAgent: false, routes })."""
    nodes = [
        n("trigger", "trigger", "Start"),
        n("agent_0", "agent", "Router", agentId="r", agentName="Router", outputVar="Local.RouterOutput"),
        n("agent_1", "agent", "FeaturePath", agentId="f", agentName="FeaturePath"),
        n("agent_2", "agent", "BugPath", agentId="b", agentName="BugPath"),
        n("end", "end", "Done"),
        n("cond_0_0", "condition", "Route 0→1", predicate='Local.RouterOutput = "FEATURE"', branch="IF"),
        n("cond_0_1", "condition", "Route 0→2", predicate="", branch="ELSE"),
    ]
    edges = [
        ("trigger", "agent_0"),
        ("agent_0", "cond_0_0"),
        ("cond_0_0", "agent_1"),
        ("agent_0", "cond_0_1"),
        ("cond_0_1", "agent_2"),
        ("agent_1", "end"),
        ("agent_2", "end"),
    ]
    return spec(nodes, edges, pattern="handoff")


# --- specToGraph -----------------------------------------------------------------------------------------------


def test_spec_to_graph_shape():
    raw = load_story_delivery()
    raw["nodes"][0]["position"] = {"x": 1, "y": 2}
    g = spec_to_graph(parse_spec(raw))
    assert [node.type for node in g.nodes] == [
        "TRIGGER",
        "AGENT",
        "APPROVAL",
        "AGENT",
        "AGENT",
        "GATE",
        "AGENT",
        "AGENT",
        "APPROVAL",
        "END",
    ]
    assert g.nodes[0] == WorkflowNode(
        id="story-picked-up",
        type="TRIGGER",
        data={"triggerType": "manual", "label": "Story picked up", "kind": "trigger"},
    )
    assert g.nodes[1].data == {"agentId": "planner", "agentName": "Planner", "label": "Plan", "kind": "agent"}
    assert g.nodes[5].data == {"label": "Quality gate", "kind": "gate"}
    assert all(node.position is None for node in g.nodes)  # position is not carried
    assert g.edges[0] == WorkflowEdge(id="e0", source="story-picked-up", target="plan")
    assert [e.id for e in g.edges] == [f"e{i}" for i in range(9)]


def test_spec_to_graph_accepts_a_dict_and_label_kind_override_data_keys():
    node = {"id": "t", "kind": "trigger", "label": "Start", "data": {"label": "stale", "kind": "old", "extra": 1}}
    g = spec_to_graph(spec([node], []))
    assert g.nodes[0].data == {"label": "Start", "kind": "trigger", "extra": 1}


def test_kind_to_type_covers_every_kind():
    assert KIND_TO_TYPE == {
        "trigger": "TRIGGER",
        "agent": "AGENT",
        "gate": "GATE",
        "approval": "APPROVAL",
        "condition": "CONDITION",
        "set-variable": "SET_VARIABLE",
        "goto": "GOTO",
        "end": "END",
    }


def test_spec_to_graph_produces_a_parseable_graph_with_a_discoverable_trigger():
    # compiler.test.ts
    graph = graph_of(sequential_two_agents())
    trigger = find_trigger(graph)
    assert trigger is not None
    assert trigger.type == "TRIGGER"
    assert [s.id for s in successors(graph, trigger.id)] == ["agent_0"]


def test_story_delivery_walks_as_one_chain():
    graph = graph_of(load_story_delivery())
    trigger = find_trigger(graph)
    assert trigger is not None
    path = [trigger.id]
    while succ := successors(graph, path[-1]):
        assert len(succ) == 1
        path.append(succ[0].id)
    assert path == [node["id"] for node in load_story_delivery()["nodes"]]


# --- parseGraph ------------------------------------------------------------------------------------------------


def test_parse_graph_skips_bad_nodes_and_edges():
    data = {"x": 1}
    graph = parse_graph(
        [
            None,
            {"id": 5},
            {"label": "no id"},
            {"id": "a", "type": "TRIGGER", "data": data},
            {"id": "b", "data": None},
            {"id": "c", "position": {"x": 1, "y": 2}},
        ],
        [
            None,
            {"source": "a", "target": 5},
            {"source": "a", "target": "missing"},
            {"source": "a", "target": "b"},
            {"source": "ghost", "target": "c"},  # the source is not checked
            {"source": "a", "target": "c"},
        ],
    )
    assert list(graph.nodes) == ["a", "b", "c"]
    assert graph.nodes["a"].data is data  # kept by reference, like the TS spread
    assert graph.nodes["b"].data == {}
    assert graph.nodes["c"].position == {"x": 1, "y": 2}
    assert [s.id for s in successors(graph, "a")] == ["b", "c"]
    assert [s.id for s in successors(graph, "ghost")] == ["c"]
    assert successors(graph, "zzz") == []


def test_duplicate_ids_keep_the_first_position_and_the_last_value():
    graph = parse_graph([{"id": "a", "data": {"v": 1}}, {"id": "b"}, {"id": "a", "data": {"v": 2}}], [])
    assert list(graph.nodes) == ["a", "b"]
    assert graph.nodes["a"].data == {"v": 2}


def test_parse_graph_copies_workflow_nodes_and_accepts_workflow_edges():
    a = WorkflowNode(id="a", type="TRIGGER")
    b = WorkflowNode(id="b")
    graph = parse_graph([a, b], [WorkflowEdge(id="e0", source="a", target="b")])
    assert graph.nodes["a"] == a
    assert graph.nodes["a"] is not a
    assert successors(graph, "a") == [graph.nodes["b"]]


def test_successors_returns_a_copy():
    graph = parse_graph([{"id": "a"}, {"id": "b"}], [{"source": "a", "target": "b"}])
    successors(graph, "a").clear()
    assert len(successors(graph, "a")) == 1


# --- findTrigger -----------------------------------------------------------------------------------------------


def test_find_trigger_prefers_the_explicit_trigger():
    graph = parse_graph([{"id": "a"}, {"id": "t", "type": "TRIGGER"}], [{"source": "t", "target": "a"}])
    trigger = find_trigger(graph)
    assert trigger is not None and trigger.id == "t"


def test_find_trigger_falls_back_to_the_first_node_without_incoming_edges_that_is_not_a_note():
    graph = parse_graph(
        [{"id": "b"}, {"id": "note", "type": "NOTE"}, {"id": "a"}],
        [{"source": "a", "target": "b"}],
    )
    trigger = find_trigger(graph)
    assert trigger is not None and trigger.id == "a"


def test_find_trigger_falls_back_to_the_first_node_declared():
    graph = parse_graph([{"id": "a"}, {"id": "b"}], [{"source": "a", "target": "b"}, {"source": "b", "target": "a"}])
    trigger = find_trigger(graph)
    assert trigger is not None and trigger.id == "a"
    assert find_trigger(parse_graph([], [])) is None


# --- resolveSuccessors -----------------------------------------------------------------------------------------


def test_condition_precedence():
    assert CONDITION_PRECEDENCE == {"IF": 0, "ELSE_IF": 1, "ELSE": 2}


@pytest.mark.parametrize(("output", "target"), [("FEATURE", "agent_1__plan"), ("BUG", "agent_2__plan")])
def test_handoff_routes_to_the_matching_branch(output, target):
    # mockRuntime/langGraphRuntime "handoff routes to the matching branch by agent output".
    graph = graph_of(handoff_router())
    ctx = RunContext({"Local.RouterOutput": output})
    assert resolve_successors(graph, "trigger", ctx, entry_id) == ["agent_0__plan"]
    assert resolve_successors(graph, "agent_0", ctx, entry_id) == [target]
    assert resolve_successors(graph, "agent_1", ctx, entry_id) == [END]


def branches(*conds, others=()):
    """src → each (id, branch, predicate) condition → its own target `t_<id>`; plus plain successors `others`."""
    nodes = [n("src", "gate")]
    edges = []
    for other in others:
        nodes.append(n(other, "gate"))
        edges.append(("src", other))
    for cid, branch, predicate in conds:
        data = {"predicate": predicate}
        if branch is not None:
            data["branch"] = branch
        nodes += [n(cid, "condition", **data), n(f"t_{cid}", "gate")]
        edges += [("src", cid), (cid, f"t_{cid}")]
    return graph_of(spec(nodes, edges))


def test_precedence_beats_edge_order():
    graph = branches(("e", "ELSE", ""), ("ei", "ELSE_IF", "Local.B"), ("i", "IF", "Local.A"))
    assert resolve_successors(graph, "src", RunContext({"Local.A": True}), entry_id) == ["t_i"]
    assert resolve_successors(graph, "src", RunContext({"Local.B": True}), entry_id) == ["t_ei"]
    assert resolve_successors(graph, "src", RunContext(), entry_id) == ["t_e"]


def test_exactly_one_branch_wins_even_when_several_hold():
    graph = branches(("i1", "IF", "true"), ("i2", "IF", "true"))
    assert resolve_successors(graph, "src", RunContext(), entry_id) == ["t_i1"]


def test_missing_or_unknown_branch_ranks_as_if_and_ties_keep_edge_order():
    graph = branches(("e", "ELSE", ""), ("x", None, "true"), ("y", "WHATEVER", "true"))
    assert resolve_successors(graph, "src", RunContext(), entry_id) == ["t_x"]


def test_no_branch_holds_and_no_else_routes_nowhere():
    graph = branches(("i", "IF", "Local.A"))
    assert resolve_successors(graph, "src", RunContext(), entry_id) == []


def test_a_numeric_zero_predicate_is_false_not_empty():
    # String(0 ?? '') === '0' → falsy; only null/undefined become the always-true empty predicate.
    graph = parse_graph(
        [
            {"id": "src", "data": {"kind": "gate"}},
            {"id": "i", "data": {"kind": "condition", "branch": "IF", "predicate": 0}},
            {"id": "e", "data": {"kind": "condition", "branch": "ELSE", "predicate": None}},
            {"id": "t_i", "data": {"kind": "gate"}},
            {"id": "t_e", "data": {"kind": "gate"}},
        ],
        [
            {"source": "src", "target": "i"},
            {"source": "src", "target": "e"},
            {"source": "i", "target": "t_i"},
            {"source": "e", "target": "t_e"},
        ],
    )
    assert resolve_successors(graph, "src", RunContext(), entry_id) == ["t_e"]


def test_plain_successors_come_first_and_always_route():
    graph = branches(("i", "IF", "true"), others=("p1", "p2"))
    assert resolve_successors(graph, "src", RunContext(), entry_id) == ["p1", "p2", "t_i"]


def test_nested_conditions_and_entry_ids():
    nodes = [
        n("src", "gate"),
        n("c1", "condition", predicate="", branch="ELSE"),
        n("c2", "condition", predicate="Local.Go", branch="IF"),
        n("ag", "agent", agentId="x"),
        n("ap", "approval"),
        n("end", "end"),
    ]
    edges = [("src", "c1"), ("c1", "c2"), ("c1", "ap"), ("c2", "ag"), ("c2", "end")]
    graph = graph_of(spec(nodes, edges))
    assert resolve_successors(graph, "src", RunContext({"Local.Go": 1}), entry_id) == ["ap__begin", "ag__plan", END]
    assert resolve_successors(graph, "src", RunContext(), entry_id) == ["ap__begin"]


def test_a_condition_cycle_stops_at_a_visited_condition():
    nodes = [n("src", "gate"), n("c1", "condition", predicate="true"), n("x", "gate")]
    graph = graph_of(spec(nodes, [("src", "c1"), ("c1", "c1"), ("c1", "x")]))
    assert resolve_successors(graph, "src", RunContext(), entry_id) == ["x"]


def test_duplicates_are_left_for_the_caller():
    nodes = [n("src", "gate"), n("c", "condition", predicate=""), n("x", "gate")]
    graph = graph_of(spec(nodes, [("src", "x"), ("src", "c"), ("c", "x")]))
    assert resolve_successors(graph, "src", RunContext(), entry_id) == ["x", "x"]


def test_a_goto_loop_hits_the_max_step_budget():
    # mockRuntime/langGraphRuntime "(3) a goto loop hits the max-step budget and stops with a clear reason":
    # drive trigger → loop (goto → loop) the way the compiled graph routes it, ticking per node execution.
    looper = spec(
        [n("trigger", "trigger", "Start"), n("loop", "goto", "Loop", targetId="loop")],
        [("trigger", "loop")],
        budget={"maxSteps": 5, "timeoutMs": 60_000},
    )
    parsed = parse_spec(looper)
    graph = graph_of(parsed)
    trigger = find_trigger(graph)
    assert trigger is not None
    guard = GuardState(parsed.budget, 0)
    ctx = RunContext()
    frontier = resolve_successors(graph, trigger.id, ctx, entry_id)
    executed = 0
    with pytest.raises(BudgetExceededError) as err:
        while frontier:
            node = graph.nodes[frontier.pop(0)]
            guard.tick(1)
            executed += 1
            nxt = resolve_successors(graph, node.id, ctx, entry_id)
            target = graph.nodes.get(str(node.data.get("targetId") or ""))
            if kind_of(node) == "goto" and target is not None:
                nxt.append(entry_id(target))
            frontier.extend(dict.fromkeys(nxt))
    assert executed == 5
    assert err.value.cause == "max-steps"
    assert "node executions" in str(err.value).lower()
