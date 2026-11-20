import pytest
from pydantic import ValidationError

from app.spec.models import (
    DEFAULT_RUN_BUDGET,
    SPEC_NODE_KINDS,
    RunBudget,
    SpecNode,
    SpecNodeData,
    WorkflowSpec,
    parse_spec,
    spec_to_json,
)
from tests.fixtures import load_story_delivery


def minimal(**overrides):
    spec = {
        "specVersion": 1,
        "name": "W",
        "description": "",
        "pattern": "sequential",
        "nodes": [
            {"id": "start", "kind": "trigger", "label": "Start", "data": {}},
            {"id": "done", "kind": "end", "label": "Done", "data": {}},
        ],
        "edges": [{"source": "start", "target": "done"}],
        "budget": {"maxSteps": 50, "timeoutMs": 300000, "maxTokens": 0},
    }
    spec.update(overrides)
    return spec


def test_default_run_budget_matches_ts():
    assert DEFAULT_RUN_BUDGET.model_dump(mode="json", exclude_none=True) == {
        "maxSteps": 50,
        "timeoutMs": 300000,
        "maxTokens": 0,
    }
    assert isinstance(DEFAULT_RUN_BUDGET, RunBudget)


def test_story_delivery_round_trips_unchanged():
    raw = load_story_delivery()
    spec = parse_spec(raw)
    assert spec.name == "Story delivery"
    assert [n.kind for n in spec.nodes] == [
        "trigger",
        "agent",
        "approval",
        "agent",
        "agent",
        "gate",
        "agent",
        "agent",
        "approval",
        "end",
    ]
    assert spec.nodes[1].data.agentId == "planner"
    assert spec_to_json(spec) == raw


def test_story_delivery_shape_matches_ts_test():
    # storyDeliverySpec.test.ts: one chain, each agent bound to its built-in slug.
    spec = parse_spec(load_story_delivery())
    bound = {"plan": "planner", "implement": "implementer", "test": "tester", "review": "reviewer"}
    bound["pr-description"] = "pr-author"
    for node_id, slug in bound.items():
        assert next(n for n in spec.nodes if n.id == node_id).data.agentId == slug
    assert len(spec.edges) == len(spec.nodes) - 1
    for i, e in enumerate(spec.edges):
        assert (e.source, e.target) == (spec.nodes[i].id, spec.nodes[i + 1].id)


def test_no_nulls_are_added_for_absent_optional_fields():
    raw = minimal(
        nodes=[
            {"id": "start", "kind": "trigger", "label": "Start", "data": {"triggerType": "issue"}},
            {"id": "a", "kind": "agent", "label": "A", "data": {"agentId": "x", "skills": ["s"], "harness": "codex"}},
            {"id": "done", "kind": "end", "label": "Done", "data": {}, "position": {"x": 1, "y": 2.5}},
        ],
    )
    out = spec_to_json(parse_spec(raw))
    assert out == raw
    assert out["nodes"][0]["data"] == {"triggerType": "issue"}
    assert "position" not in out["nodes"][0]


def test_unknown_keys_round_trip_everywhere():
    raw = minimal(extraTop={"a": 1})
    raw["nodes"][0]["data"]["customField"] = [1, 2]
    raw["nodes"][0]["selected"] = True
    raw["edges"][0]["sourceHandle"] = "out"
    raw["budget"]["note"] = "x"
    spec = parse_spec(raw)
    assert spec.nodes[0].data.model_extra == {"customField": [1, 2]}
    assert spec_to_json(spec) == raw


def test_every_optional_data_field_from_spec_ts_is_modelled():
    fields = set(SpecNodeData.model_fields)
    expected = {
        "triggerType",
        "issueSource",
        "adoOrg",
        "adoProject",
        "workItemType",
        "wiql",
        "agentId",
        "agentName",
        "skills",
        "sdlcStep",
        "outputVar",
        "harness",
        "requirePlanApproval",
        "gateStep",
        "gateResultVar",
        "question",
        "approvalVar",
        "approvalDefault",
        "predicate",
        "branch",
        "variable",
        "value",
        "targetId",
    }
    assert fields == expected
    assert SPEC_NODE_KINDS == ("trigger", "agent", "gate", "approval", "condition", "set-variable", "goto", "end")


def test_missing_budget_parses_with_the_default_budget_as_a_copy():
    raw = minimal()
    del raw["budget"]
    spec = parse_spec(raw)
    assert spec.budget == DEFAULT_RUN_BUDGET
    assert spec.budget is not DEFAULT_RUN_BUDGET
    spec.budget.maxSteps = 1
    assert DEFAULT_RUN_BUDGET.maxSteps == 50
    assert spec_to_json(parse_spec({**raw, "budget": None}))["budget"] == {
        "maxSteps": 50,
        "timeoutMs": 300000,
        "maxTokens": 0,
    }


def test_lenient_defaults_for_name_description_pattern_label_and_data():
    raw = {
        "specVersion": 1,
        "nodes": [{"id": "start", "kind": "trigger"}, {"id": "done", "kind": "end", "label": "Done", "data": None}],
        "edges": [],
    }
    spec = parse_spec(raw)
    assert (spec.name, spec.description, spec.pattern) == ("", "", "sequential")
    assert spec.nodes[0].label == ""
    assert spec.nodes[1].data == SpecNodeData()


def test_budget_numbers_keep_their_json_type():
    spec = parse_spec(minimal(budget={"maxSteps": 5, "timeoutMs": 1500.5}))
    assert spec_to_json(spec)["budget"] == {"maxSteps": 5, "timeoutMs": 1500.5}
    assert isinstance(spec.budget.maxSteps, int)


def test_set_variable_value_keeps_non_string_json():
    node = SpecNode.model_validate({"id": "s", "kind": "set-variable", "label": "S", "data": {"value": 3}})
    assert node.data.value == 3


@pytest.mark.parametrize("version", [2, "1", True, None])
def test_not_a_spec_version_one_is_rejected(version):
    with pytest.raises(ValidationError):
        parse_spec(minimal(specVersion=version))


def test_spec_version_one_point_zero_is_one_like_in_js():
    assert parse_spec(minimal(specVersion=1.0)).specVersion == 1


def test_unknown_kind_and_non_list_nodes_are_rejected():
    raw = minimal()
    raw["nodes"][0]["kind"] = "note"
    with pytest.raises(ValidationError):
        parse_spec(raw)
    with pytest.raises(ValidationError):
        parse_spec(minimal(nodes={}))


def test_parse_spec_passes_a_model_through():
    spec = parse_spec(minimal())
    assert parse_spec(spec) is spec
    assert isinstance(spec, WorkflowSpec)
