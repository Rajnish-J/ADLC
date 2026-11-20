"""Graph helpers (port of apps/extension/src/runtime/graph.ts, compile/specToGraph.ts and `resolveSuccessors` from
langgraph/specToStateGraph.ts).

`spec_to_graph` adapts a WorkflowSpec into the orka node/edge shape; `parse_graph` turns that into an adjacency map;
`resolve_successors` picks a node's real successors, passing through condition nodes by IF/ELSE_IF/ELSE precedence.
Pure: no DB, no LangGraph.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Final

from app.engine.conditions import evaluate_condition
from app.engine.context import RunContext
from app.spec.jscompat import js_str
from app.spec.models import WorkflowSpec, parse_spec, spec_to_json


@dataclass
class WorkflowNode:
    id: str
    data: dict[str, Any] = field(default_factory=dict)
    """For spec nodes: the SpecNodeData fields that are set, plus `label` and `kind`."""
    type: str | None = None
    """Uppercase node type the interpreter switches on (`TRIGGER`, `AGENT`, …)."""
    position: dict[str, Any] | None = None


@dataclass
class WorkflowEdge:
    id: str
    source: str
    target: str


@dataclass
class ParsedGraph:
    nodes: dict[str, WorkflowNode]
    outgoing: dict[str, list[WorkflowNode]]
    """node id -> outgoing successor nodes, in edge declaration order"""


@dataclass
class RuntimeGraph:
    nodes: list[WorkflowNode]
    edges: list[WorkflowEdge]


CONDITION_PRECEDENCE: Final[dict[str, int]] = {
    "IF": 0,
    "ELSE_IF": 1,
    "ELSE": 2,
}

# SpecNode.kind -> the `type` string the interpreter switches on (orka's uppercase convention).
KIND_TO_TYPE: Final[dict[str, str]] = {
    "trigger": "TRIGGER",
    "agent": "AGENT",
    "gate": "GATE",
    "approval": "APPROVAL",
    "condition": "CONDITION",
    "set-variable": "SET_VARIABLE",
    "goto": "GOTO",
    "end": "END",
}

_MISSING: Final = object()


def _get(raw: Any, key: str) -> Any:
    if isinstance(raw, Mapping):
        return raw.get(key, _MISSING)
    if isinstance(raw, (WorkflowNode, WorkflowEdge)):
        return getattr(raw, key, _MISSING)
    return _MISSING


def parse_graph(nodes_raw: Iterable[Any], edges_raw: Iterable[Any]) -> ParsedGraph:
    """Nodes/edges may be WorkflowNode/WorkflowEdge instances or plain dicts. A node needs a string id; an edge
    needs string endpoints and an existing target (its source is not checked — same as the TS)."""
    nodes: dict[str, WorkflowNode] = {}
    for raw in nodes_raw:
        if isinstance(raw, WorkflowNode):
            nodes[raw.id] = replace(raw)
            continue
        node_id = _get(raw, "id")
        if not isinstance(node_id, str):
            continue
        data = _get(raw, "data")
        node_type = _get(raw, "type")
        position = _get(raw, "position")
        nodes[node_id] = WorkflowNode(
            id=node_id,
            data=data if isinstance(data, dict) else dict(data) if isinstance(data, Mapping) else {},
            type=node_type if isinstance(node_type, str) else None,
            position=dict(position) if isinstance(position, Mapping) else None,
        )

    outgoing: dict[str, list[WorkflowNode]] = {}
    for raw in edges_raw:
        source = _get(raw, "source")
        target = _get(raw, "target")
        if not isinstance(source, str) or not isinstance(target, str):
            continue
        target_node = nodes.get(target)
        if target_node is None:
            continue
        outgoing.setdefault(source, []).append(target_node)

    return ParsedGraph(nodes=nodes, outgoing=outgoing)


def find_trigger(graph: ParsedGraph) -> WorkflowNode | None:
    """The entry node — the explicit TRIGGER, else the first node with no incoming edge (that isn't a NOTE), else
    the first node declared."""
    for node in graph.nodes.values():
        if node.type == "TRIGGER":
            return node
    has_incoming = {s.id for succs in graph.outgoing.values() for s in succs}
    for node in graph.nodes.values():
        if node.id not in has_incoming and node.type != "NOTE":
            return node
    return next(iter(graph.nodes.values()), None)


def successors(graph: ParsedGraph, node_id: str) -> list[WorkflowNode]:
    return list(graph.outgoing.get(node_id, []))


def kind_of(node: WorkflowNode) -> str | None:
    """The spec kind `spec_to_graph` stored in `node.data["kind"]`."""
    kind = node.data.get("kind")
    return kind if isinstance(kind, str) else None


def _to_node(node_json: Mapping[str, Any]) -> WorkflowNode:
    kind = node_json["kind"]
    data = node_json.get("data") or {}
    return WorkflowNode(
        id=node_json["id"],
        type=KIND_TO_TYPE[kind],
        # Carry the spec payload plus the label so the interpreter has everything in one bag.
        data={**data, "label": node_json.get("label", ""), "kind": kind},
    )


def spec_to_graph(spec: WorkflowSpec | Mapping[str, Any]) -> RuntimeGraph:
    """Adapt a spec into the orka graph shape. Node data holds only the SpecNodeData fields that are set (no None
    values), plus `label` and `kind`; `position` is not carried. Edge ids are `e0`, `e1`, …"""
    spec_json = spec_to_json(parse_spec(spec))
    return RuntimeGraph(
        nodes=[_to_node(n) for n in spec_json["nodes"]],
        edges=[
            WorkflowEdge(id=f"e{i}", source=e["source"], target=e["target"]) for i, e in enumerate(spec_json["edges"])
        ],
    )


def _precedence(node: WorkflowNode) -> int:
    branch = node.data.get("branch")
    return CONDITION_PRECEDENCE.get(js_str("IF" if branch is None else branch), 0)


def _predicate(node: WorkflowNode) -> str:
    predicate = node.data.get("predicate")
    return js_str("" if predicate is None else predicate)


def resolve_successors(
    graph: ParsedGraph,
    source_id: str,
    ctx: RunContext,
    entry_id: Callable[[WorkflowNode], str],
    visited: frozenset[str] = frozenset(),
) -> list[str]:
    """A spec node's real successors as entry ids, passing through `condition` nodes (recursively, so nested
    branches work) and picking exactly one winning condition branch by IF/ELSE_IF/ELSE precedence (stable: ties keep
    edge order; the first branch whose predicate holds wins). Non-condition successors come first, in edge order.
    The result may contain duplicates — the caller de-duplicates. `entry_id` maps a target node to the id a
    predecessor should route to (e.g. an agent's `__plan` node, or END for an end node)."""
    succs = successors(graph, source_id)
    condition_succs = [s for s in succs if kind_of(s) == "condition"]
    out = [entry_id(s) for s in succs if kind_of(s) != "condition"]

    if condition_succs:
        ordered = sorted(condition_succs, key=_precedence)
        winner = next((c for c in ordered if evaluate_condition(_predicate(c), ctx)), None)
        if winner is not None and winner.id not in visited:
            out.extend(resolve_successors(graph, winner.id, ctx, entry_id, visited | {winner.id}))
    return out
