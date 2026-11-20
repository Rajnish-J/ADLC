"""Structural checks for a WorkflowSpec before it is saved (port of `validateWorkflowSpec`,
packages/core/src/runtime/workflowDraft.ts).

Messages and their order are identical to the TypeScript: the API returns them to users and the chat assistant
matches on them. The check runs on the raw JSON shape, so it also accepts a dict that would not parse into a
WorkflowSpec (a missing id or label is reported here as a message rather than raised as a ValidationError).
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from app.spec.jscompat import UNDEFINED, js_key, js_str, js_trim, js_truthy
from app.spec.models import WorkflowSpec, spec_to_json


@dataclass
class SpecValidation:
    errors: list[str] = field(default_factory=list)
    """Problems that make the spec unusable; it must not be saved."""
    warnings: list[str] = field(default_factory=list)
    """Things worth fixing that don't block saving (e.g. an agent step nobody is mapped to yet)."""

    @property
    def ok(self) -> bool:
        return not self.errors


def _prop(obj: Any, key: str) -> Any:
    """`obj.key` with JS semantics: a missing key (or a non-object) reads as UNDEFINED."""
    if isinstance(obj, Mapping):
        return obj.get(key, UNDEFINED)
    return UNDEFINED


def _data(node: Any) -> Any:
    # TS reads `n.data.x` without a guard (it would throw on a node without data); treat that as empty data.
    data = _prop(node, "data")
    return data if isinstance(data, Mapping) else {}


def _has_text(v: Any) -> bool:
    """`!!v?.trim()` — a non-blank string."""
    return isinstance(v, str) and js_trim(v) != ""


def validate_workflow_spec(spec: WorkflowSpec | Mapping[str, Any]) -> SpecValidation:
    """Ids, edges, one trigger, an end, everything reachable from the trigger."""
    raw: Any = spec_to_json(spec) if isinstance(spec, WorkflowSpec) else spec
    if not isinstance(raw, Mapping):
        raw = {}
    errors: list[str] = []
    warnings: list[str] = []

    version = _prop(raw, "specVersion")
    if not (isinstance(version, (int, float)) and not isinstance(version, bool) and version == 1):
        errors.append("Unsupported spec version.")
    if not _has_text(_prop(raw, "name")):
        errors.append("The workflow needs a name.")
    nodes = _prop(raw, "nodes")
    edges = _prop(raw, "edges")
    if not isinstance(nodes, (list, tuple)) or not isinstance(edges, (list, tuple)):
        errors.append("The workflow has no steps.")
        return SpecValidation(errors, warnings)

    ids: set[tuple[Any, ...]] = set()
    for n in nodes:
        node_id = _prop(n, "id")
        if not js_truthy(node_id):
            errors.append(f'A step ("{js_str(_prop(n, "label"))}") has no id.')
        elif js_key(node_id) in ids:
            errors.append(f'Two steps share the id "{js_str(node_id)}".')
        ids.add(js_key(node_id))  # even a missing id is recorded, exactly as the TS does
        if not _has_text(_prop(n, "label")):
            errors.append(f'Step "{js_str(node_id)}" has no label.')
    triggers = [n for n in nodes if _prop(n, "kind") == "trigger"]
    if len(triggers) != 1:
        errors.append("A workflow needs exactly one trigger.")
    if not any(_prop(n, "kind") == "end" for n in nodes):
        errors.append("A workflow needs an end step.")
    for e in edges:
        source, target = _prop(e, "source"), _prop(e, "target")
        if js_key(source) not in ids or js_key(target) not in ids:
            errors.append(f"An edge points at a missing step ({js_str(source)} → {js_str(target)}).")
        elif js_key(source) == js_key(target):
            errors.append(f'Step "{js_str(source)}" points at itself.')
    for n in nodes:
        kind = _prop(n, "kind")
        data = _data(n)
        if kind == "goto":
            target_id = data.get("targetId", UNDEFINED)
            if not js_truthy(target_id) or js_key(target_id) not in ids:
                errors.append(f'"{js_str(_prop(n, "label"))}" jumps to a missing step.')
        if kind == "agent" and not js_truthy(data.get("agentId", UNDEFINED)):
            warnings.append(f'"{js_str(_prop(n, "label"))}" has no agent mapped yet.')
    if errors or len(triggers) != 1:
        return SpecValidation(errors, warnings)

    # Everything must be reachable from the trigger, and an end must be reachable.
    nxt: dict[tuple[Any, ...], list[tuple[Any, ...]]] = {}
    for e in edges:
        nxt.setdefault(js_key(_prop(e, "source")), []).append(js_key(_prop(e, "target")))
    for n in nodes:
        target_id = _data(n).get("targetId", UNDEFINED)
        if _prop(n, "kind") == "goto" and js_truthy(target_id):
            nxt.setdefault(js_key(_prop(n, "id")), []).append(js_key(target_id))
    start = js_key(_prop(triggers[0], "id"))
    reached = {start}
    queue = deque([start])
    while queue:
        for t in nxt.get(queue.popleft(), []):
            if t not in reached:
                reached.add(t)
                queue.append(t)
    orphans = [n for n in nodes if js_key(_prop(n, "id")) not in reached]
    if orphans:
        names = ", ".join(f'"{js_str(_prop(n, "label"))}"' for n in orphans)
        errors.append(f"Not reachable from the trigger: {names}.")
    if not any(_prop(n, "kind") == "end" and js_key(_prop(n, "id")) in reached for n in nodes):
        errors.append("No end step is reachable from the trigger.")
    return SpecValidation(errors, warnings)
