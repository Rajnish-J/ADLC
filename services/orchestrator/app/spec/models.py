"""The WorkflowSpec IR (port of packages/core/src/runtime/spec.ts).

Attribute names are the camelCase JSON keys, so a spec round-trips through `parse_spec` / `spec_to_json` unchanged:
unknown keys are kept (`extra="allow"` on every model) and absent optional fields are not written back as nulls.

Parsing is deliberately lenient, like the TypeScript side (whose API schema only checks `specVersion === 1` and that
`nodes`/`edges` are arrays): a missing `budget` becomes DEFAULT_RUN_BUDGET, a missing `name`/`description` becomes
"", a missing `pattern` becomes "sequential", and a missing or null node `data` becomes `{}`. Structural problems
(missing ids, empty labels, dangling edges, unreachable steps) are reported by `app.spec.validate`, not here — run
`validate_workflow_spec` on the raw dict first when the input comes from a user.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

WorkflowPattern = Literal["sequential", "handoff"]
"""The orchestration patterns the MVP ships."""

SpecNodeKind = Literal["trigger", "agent", "gate", "approval", "condition", "set-variable", "goto", "end"]
SPEC_NODE_KINDS: Final[tuple[SpecNodeKind, ...]] = (
    "trigger",
    "agent",
    "gate",
    "approval",
    "condition",
    "set-variable",
    "goto",
    "end",
)

# Documented value sets for SpecNodeData fields. The fields themselves are typed `str` so a stored spec with an
# unexpected value still loads (the TypeScript runtime never validated them either).
TriggerType = Literal["manual", "issue"]
IssueSource = Literal["azure-devops"]
SdlcStep = Literal["design", "implement", "review", "release"]
ConditionBranch = Literal["IF", "ELSE_IF", "ELSE"]

JsonNumber = int | float


class _SpecModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class Position(_SpecModel):
    """Persisted canvas position (top-left)."""

    x: JsonNumber
    y: JsonNumber


class SpecNodeData(_SpecModel):
    """Union of the per-kind payloads. Optional fields are populated only for the relevant kind."""

    # trigger
    triggerType: str | None = None
    """How a run is seeded: `manual` (default) or `issue` (TriggerType)."""
    issueSource: str | None = None
    """The backlog the issue trigger reads from (IssueSource)."""
    adoOrg: str | None = None
    adoProject: str | None = None
    workItemType: str | None = None
    wiql: str | None = None

    # agent
    agentId: str | None = None
    """Catalog agent id/slug this node runs."""
    agentName: str | None = None
    skills: list[str] | None = None
    sdlcStep: str | None = None
    """SDLC step this agent's output is gated at (SdlcStep)."""
    outputVar: str | None = None
    """Variable the agent response is captured into (e.g. `Local.DesignerResult`)."""
    harness: str | None = None
    """The harness this agent step runs in. Unset = the harness the run was started with."""
    requirePlanApproval: bool | None = None
    """Whether the agent plans first and waits for a person's approval. Unset = true."""

    # gate
    gateStep: str | None = None
    """SDLC step whose policy the gate enforces (SdlcStep)."""
    gateResultVar: str | None = None

    # approval
    question: str | None = None
    approvalVar: str | None = None
    approvalDefault: str | None = None

    # condition
    predicate: str | None = None
    """PowerFx-ish predicate (see app.engine.conditions)."""
    branch: str | None = None
    """IF / ELSE_IF / ELSE (ConditionBranch) — drives precedence in a condition switch."""

    # set-variable
    variable: str | None = None
    value: Any = None
    """Typed `string` in the TS spec, but RunContext.interpolate passes non-strings through, so any JSON is kept."""

    # goto
    targetId: str | None = None


class SpecNode(_SpecModel):
    id: str
    kind: SpecNodeKind
    label: str = ""
    data: SpecNodeData = Field(default_factory=SpecNodeData)
    position: Position | None = None

    @field_validator("data", mode="before")
    @classmethod
    def _null_data_is_empty(cls, v: Any) -> Any:
        return {} if v is None else v


class SpecEdge(_SpecModel):
    source: str
    target: str


class RunBudget(_SpecModel):
    """Per-run safety budget, enforced by app.engine.guards.GuardState."""

    maxSteps: JsonNumber
    """Hard ceiling on node executions — stops unbounded goto loops."""
    timeoutMs: JsonNumber
    """Wall-clock ceiling in ms (time paused awaiting a human is excluded)."""
    maxTokens: JsonNumber | None = None
    """Optional token ceiling across agent steps (0 / None = unbounded)."""


DEFAULT_RUN_BUDGET: Final = RunBudget(maxSteps=50, timeoutMs=5 * 60_000, maxTokens=0)


def _default_budget() -> RunBudget:
    return DEFAULT_RUN_BUDGET.model_copy(deep=True)


class WorkflowSpec(_SpecModel):
    specVersion: Literal[1]
    name: str = ""
    description: str = ""
    pattern: WorkflowPattern = "sequential"
    nodes: list[SpecNode]
    edges: list[SpecEdge]
    budget: RunBudget = Field(default_factory=_default_budget)

    @field_validator("specVersion", mode="before")
    @classmethod
    def _version_is_a_number(cls, v: Any) -> Any:
        # TS checks `specVersion === 1`: `true` is not 1 there, although pydantic's lax Literal[1] would accept it.
        if isinstance(v, bool):
            raise ValueError("Unsupported spec version.")
        return v

    @field_validator("name", "description", mode="before")
    @classmethod
    def _null_text_is_empty(cls, v: Any) -> Any:
        return "" if v is None else v

    @field_validator("pattern", mode="before")
    @classmethod
    def _null_pattern_is_sequential(cls, v: Any) -> Any:
        return "sequential" if v is None else v

    @field_validator("budget", mode="before")
    @classmethod
    def _null_budget_is_default(cls, v: Any) -> Any:
        return _default_budget() if v is None else v


def parse_spec(raw: Mapping[str, Any] | WorkflowSpec) -> WorkflowSpec:
    """Parse a spec dict (e.g. a `workflows.spec` JSON column). Raises pydantic.ValidationError when it is not a
    spec at all (specVersion != 1, nodes/edges not lists, a node without a string id or with an unknown kind)."""
    if isinstance(raw, WorkflowSpec):
        return raw
    return WorkflowSpec.model_validate(raw)


def spec_to_json(spec: WorkflowSpec) -> dict[str, Any]:
    """The spec as JSON-ready data, shaped like the TypeScript object: unknown keys kept, no `null`s for absent
    optional fields."""
    return spec.model_dump(mode="json", by_alias=True, exclude_none=True)
