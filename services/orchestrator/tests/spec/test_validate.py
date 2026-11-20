"""validateWorkflowSpec port — messages and ordering must match packages/core/src/runtime/workflowDraft.ts exactly.

Includes the validate cases from apps/api/src/chat/chat.test.ts ("linear workflow drafts").
"""

import copy

import pytest

from app.spec.models import parse_spec
from app.spec.validate import SpecValidation, validate_workflow_spec
from tests.fixtures import load_story_delivery


def node(id, kind, label=None, **data):
    n = {"id": id, "kind": kind, "label": label if label is not None else id.title(), "data": data}
    return n


def chain(*nodes, extra_edges=()):
    """A spec whose nodes are linked in order (like workflowDraftToSpec produces)."""
    edges = [{"source": a["id"], "target": b["id"]} for a, b in zip(nodes, nodes[1:], strict=False)]
    return {
        "specVersion": 1,
        "name": "W",
        "description": "",
        "pattern": "sequential",
        "nodes": list(nodes),
        "edges": edges + list(extra_edges),
        "budget": {"maxSteps": 50, "timeoutMs": 300000, "maxTokens": 0},
    }


def test_story_delivery_is_valid_with_no_warnings():
    result = validate_workflow_spec(load_story_delivery())
    assert result == SpecValidation(errors=[], warnings=[])
    assert result.ok


def test_story_delivery_model_is_valid():
    assert validate_workflow_spec(parse_spec(load_story_delivery())).errors == []


def test_catches_broken_specs():
    # chat.test.ts: bad.edges = bad.edges.slice(0, 3) → /Not reachable/
    bad = load_story_delivery()
    bad["edges"] = bad["edges"][:3]
    assert validate_workflow_spec(bad).errors == [
        'Not reachable from the trigger: "Test", "Quality gate", "Review", "PR description", "Merge approval", "Done".',
        "No end step is reachable from the trigger.",
    ]


def test_a_draft_compiled_spec_with_rederived_ids_is_valid():
    # chat.test.ts "re-derives duplicate and reserved step ids": workflowDraftToSpec output for that draft.
    spec = chain(
        node("start", "trigger", "Story picked up", triggerType="manual"),
        node("a", "agent", "One"),
        node("two", "agent", "Two"),
        node("sign-off", "approval", "Sign off", question='Approve "Sign off"?'),
        node("done", "end", "Done"),
    )
    result = validate_workflow_spec(spec)
    assert result.errors == []
    assert result.warnings == ['"One" has no agent mapped yet.', '"Two" has no agent mapped yet.']


def test_unsupported_version_and_missing_name():
    spec = chain(node("start", "trigger"), node("done", "end"))
    spec["specVersion"] = 2
    spec["name"] = "   "
    assert validate_workflow_spec(spec).errors == ["Unsupported spec version.", "The workflow needs a name."]
    spec["specVersion"] = True  # `true !== 1` in JS
    del spec["name"]
    assert validate_workflow_spec(spec).errors == ["Unsupported spec version.", "The workflow needs a name."]


def test_version_one_point_zero_is_supported():
    spec = chain(node("start", "trigger"), node("done", "end"))
    spec["specVersion"] = 1.0
    assert validate_workflow_spec(spec).errors == []


def test_no_steps_returns_early():
    spec = {"specVersion": 3, "name": "W", "nodes": "nope", "edges": []}
    assert validate_workflow_spec(spec) == SpecValidation(
        errors=["Unsupported spec version.", "The workflow has no steps."], warnings=[]
    )
    assert validate_workflow_spec({"specVersion": 1, "name": "W", "nodes": []}).errors == ["The workflow has no steps."]


def test_not_an_object_reports_like_a_primitive_in_js():
    assert validate_workflow_spec("spec").errors == [  # type: ignore[arg-type]
        "Unsupported spec version.",
        "The workflow needs a name.",
        "The workflow has no steps.",
    ]


def test_errors_and_warnings_keep_the_ts_order():
    spec = {
        "specVersion": 2,
        "name": " ",
        "nodes": [
            {"id": "t", "kind": "trigger", "label": "Start", "data": {}},
            {"id": "t", "kind": "end", "label": "", "data": {}},
            {"kind": "agent", "label": "X", "data": {}},
            {"id": "g", "kind": "goto", "label": "Jump", "data": {"targetId": "nowhere"}},
        ],
        "edges": [{"source": "t", "target": "nope"}, {"source": "t", "target": "t"}],
    }
    assert validate_workflow_spec(spec) == SpecValidation(
        errors=[
            "Unsupported spec version.",
            "The workflow needs a name.",
            'Two steps share the id "t".',
            'Step "t" has no label.',
            'A step ("X") has no id.',
            "An edge points at a missing step (t → nope).",
            'Step "t" points at itself.',
            '"Jump" jumps to a missing step.',
        ],
        warnings=['"X" has no agent mapped yet.'],
    )


def test_js_string_conversion_in_messages():
    spec = chain(node("start", "trigger"), node("done", "end"))
    spec["nodes"].append({"kind": "gate"})  # no id, no label → `${undefined}`
    spec["nodes"].append({"id": "", "kind": "gate", "label": None})
    spec["edges"].append({"source": "start"})
    assert validate_workflow_spec(spec).errors == [
        'A step ("undefined") has no id.',
        'Step "undefined" has no label.',
        'A step ("null") has no id.',
        'Step "" has no label.',
        # an edge whose target is undefined passes: the id-less node above put `undefined` into the id set
    ]


def test_edge_to_missing_step_message_uses_js_strings():
    spec = chain(node("start", "trigger"), node("done", "end"))
    spec["edges"].append({"source": "start", "target": 7})
    spec["edges"].append({"source": None})
    assert validate_workflow_spec(spec).errors == [
        "An edge points at a missing step (start → 7).",
        "An edge points at a missing step (null → undefined).",
    ]


@pytest.mark.parametrize(
    ("kinds", "message"),
    [
        (["agent", "end"], "A workflow needs exactly one trigger."),
        (["trigger", "trigger", "end"], "A workflow needs exactly one trigger."),
        (["trigger", "agent"], "A workflow needs an end step."),
    ],
)
def test_trigger_and_end_counts(kinds, message):
    nodes = [node(f"n{i}", k, agentId="x") for i, k in enumerate(kinds)]
    assert message in validate_workflow_spec(chain(*nodes)).errors


def test_goto_without_target_is_an_error_and_agent_without_mapping_a_warning():
    spec = chain(node("start", "trigger"), node("loop", "goto", "Loop"), node("a", "agent", "A"), node("done", "end"))
    result = validate_workflow_spec(spec)
    assert result.errors == ['"Loop" jumps to a missing step.']
    assert result.warnings == ['"A" has no agent mapped yet.']


def test_goto_targets_count_for_reachability():
    # trigger → jump, jump --goto--> done: done is reachable only through the goto.
    spec = chain(node("start", "trigger"), node("jump", "goto", "Jump", targetId="done"))
    spec["nodes"].append(node("done", "end", "Done"))
    assert validate_workflow_spec(spec).errors == []


def test_a_goto_self_loop_is_allowed_but_still_needs_a_reachable_end():
    # mockRuntime.test.ts "goto loop" spec (+ an end, which validation requires).
    spec = chain(node("trigger", "trigger", "Start"), node("loop", "goto", "Loop", targetId="loop"))
    spec["nodes"].append(node("end", "end", "Done"))
    assert validate_workflow_spec(spec).errors == [
        'Not reachable from the trigger: "Done".',
        "No end step is reachable from the trigger.",
    ]


def test_reachability_runs_only_when_there_are_no_other_errors():
    spec = chain(node("start", "trigger"), node("done", "end"))
    spec["nodes"].append(node("orphan", "gate", "Orphan"))
    assert validate_workflow_spec(spec).errors == ['Not reachable from the trigger: "Orphan".']
    spec["nodes"].append({"id": "x", "kind": "gate", "label": ""})
    assert validate_workflow_spec(spec).errors == ['Step "x" has no label.']


def test_branching_specs_are_valid():
    spec = chain(node("start", "trigger"), node("a", "agent", agentId="a"), node("done", "end"))
    spec["nodes"].insert(2, node("c", "condition", "C", predicate='Local.X = "y"', branch="IF"))
    spec["edges"] += [{"source": "a", "target": "c"}, {"source": "c", "target": "done"}]
    assert validate_workflow_spec(spec).errors == []


def test_numeric_ids_follow_js_set_identity():
    spec = chain(
        {"id": 1, "kind": "trigger", "label": "Start", "data": {}},
        {"id": "1", "kind": "end", "label": "Done", "data": {}},
    )
    # 1 and "1" are different ids (no "share the id" error) and the edge connects them.
    assert validate_workflow_spec(spec).errors == []


def test_does_not_mutate_input():
    raw = load_story_delivery()
    before = copy.deepcopy(raw)
    validate_workflow_spec(raw)
    assert raw == before
