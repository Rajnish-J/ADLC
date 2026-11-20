"""The run graph's state (port of apps/extension/src/runtime/langgraph/state.ts).

Parallel-safe by construction: when a node fans out, every branch reads the SAME input state, so the counters are
DELTA channels (nodes return what they added; the reducer sums) and a step's `seq` is assigned by the `steps`
reducer, never derived from `len(steps)` inside a node.

Steps are plain JSON dicts in the RunStep shape (camelCase keys, epoch-ms times) so checkpoints stay portable and
the gateway's run views read them unchanged once persisted to `run_steps`.
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

Step = dict[str, Any]


def merge_vars(a: dict[str, Any] | None, b: dict[str, Any] | None) -> dict[str, Any]:
    return {**(a or {}), **(b or {})}


def merge_steps_by_id(existing: list[Step] | None, incoming: list[Step] | None) -> list[Step]:
    """A new id is appended with the next `seq`; an existing id is replaced in place and keeps its `seq`."""
    out = list(existing or [])
    for step in incoming or []:
        idx = next((i for i, s in enumerate(out) if s["id"] == step["id"]), -1)
        if idx == -1:
            out.append({**step, "seq": len(out) + 1})
        else:
            out[idx] = {**step, "seq": out[idx]["seq"]}
    return out


def first_value(a: int | None, b: int | None) -> int:
    return a if a else (b or 0)


def latest(a: int | None, b: int | None) -> int:
    return max(a or 0, b or 0)


class RunGraphState(TypedDict, total=False):
    vars: Annotated[dict[str, Any], merge_vars]
    steps: Annotated[list[Step], merge_steps_by_id]
    # Total node executions / tokens so far — nodes return a DELTA; the reducer sums.
    stepCount: Annotated[int, operator.add]
    tokenCount: Annotated[int, operator.add]
    startedAt: Annotated[int, first_value]
    # Total ms paused on a human decision (excluded from the time budget). DELTA channel.
    pausedMs: Annotated[int, operator.add]
    # When the most recent node finished — i.e. when any following pause began.
    lastActiveAt: Annotated[int, latest]
