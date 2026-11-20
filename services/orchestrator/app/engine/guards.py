"""Runtime guards (port of apps/extension/src/runtime/guards.ts, adapted from the orka orchestrator).

Stops goto loops from running forever or burning unbounded tokens: the engine calls `tick()` before every logical
node execution and `add_tokens()` after each agent step. Times are epoch milliseconds; `now` is always injected.

LangGraph node functions can't rely on a captured GuardState surviving a checkpoint/resume, so every node rebuilds
one from the checkpointed counters with `GuardState.from_state` (the port of nodeHelpers.ts `reconstruct`).
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from typing import Any, Literal

from app.spec.jscompat import js_round, js_str
from app.spec.models import RunBudget

BudgetCause = Literal["max-steps", "timeout", "max-tokens"]


class BudgetExceededError(Exception):
    """Raised when a run trips a budget. The engine catches it and fails the run with `str(err)` as the reason."""

    def __init__(self, message: str, cause: BudgetCause) -> None:
        super().__init__(message)
        self.message = message
        self.cause: BudgetCause = cause
        """A machine-readable cause for the audit entry."""


def _or_zero(v: float | None) -> float:
    """`v || 0` for a number: None, NaN and 0 all become 0."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return 0
    return v


class GuardState:
    def __init__(
        self,
        budget: RunBudget | Mapping[str, Any],
        now: float,
        *,
        steps: int | None = None,
        tokens: float | None = None,
        started_at: float | None = None,
        paused_ms: float | None = None,
    ) -> None:
        """`now` is the run's start time for a fresh run. The keyword arguments seed counters from a previously
        persisted state (TS `resume`); omit them for a fresh run."""
        self._budget = budget if isinstance(budget, RunBudget) else RunBudget.model_validate(budget)
        self._steps: int = steps if steps is not None else 0
        self._tokens: float = tokens if tokens is not None else 0
        self._paused: float = paused_ms if paused_ms is not None else 0
        self._started_at: float = started_at if started_at is not None else now

    @classmethod
    def from_state(
        cls,
        budget: RunBudget | Mapping[str, Any],
        state: Mapping[str, Any],
        now: Callable[[], float],
    ) -> GuardState:
        """Rebuild from a RunGraphState (`stepCount`, `tokenCount`, `startedAt`, `pausedMs`) exactly as nodeHelpers.ts
        `reconstruct` does: a falsy/missing `startedAt` means the run starts now."""
        started_at = state.get("startedAt") or now()
        return cls(
            budget,
            started_at,
            steps=state.get("stepCount"),
            tokens=state.get("tokenCount"),
            started_at=started_at,
            paused_ms=state.get("pausedMs"),
        )

    @property
    def budget(self) -> RunBudget:
        return self._budget

    @property
    def step_count(self) -> int:
        return self._steps

    @property
    def token_count(self) -> float:
        return self._tokens

    @property
    def paused_ms(self) -> float:
        """Total time the run has spent paused awaiting a human — excluded from the time limit."""
        return self._paused

    @property
    def started_at(self) -> float:
        return self._started_at

    def add_paused_ms(self, ms: float) -> None:
        """Records time spent paused (e.g. on a plan approval) so it doesn't count against the time limit."""
        if isinstance(ms, (int, float)) and math.isfinite(ms) and ms > 0:
            self._paused += ms

    def tick(self, now: float) -> None:
        """Counts one node execution. Raises BudgetExceededError when the step budget or the time limit is exhausted.
        The time limit measures active time — wall clock since start minus time spent paused awaiting approval — so
        a run a human leaves waiting overnight still resumes."""
        self._steps += 1
        max_steps = self._budget.maxSteps
        if self._steps > max_steps:
            raise BudgetExceededError(
                f"Halted after {js_str(max_steps)} node executions — check for an unbounded goto loop.",
                "max-steps",
            )
        timeout_ms = self._budget.timeoutMs
        if now - self._started_at - self._paused > timeout_ms:
            raise BudgetExceededError(
                f"Exceeded {js_round(timeout_ms / 1000)}s run-time limit (time awaiting approval excluded).",
                "timeout",
            )

    def add_tokens(self, tokens_in: float | None, tokens_out: float | None) -> None:
        """Accumulates token usage from an agent step. Raises BudgetExceededError when the optional token budget is
        exceeded."""
        self._tokens += _or_zero(tokens_in) + _or_zero(tokens_out)
        max_tokens = self._budget.maxTokens if self._budget.maxTokens is not None else 0
        if max_tokens > 0 and self._tokens > max_tokens:
            raise BudgetExceededError(
                f"Halted after {js_str(self._tokens)} tokens — exceeded the {js_str(max_tokens)}-token per-run budget.",
                "max-tokens",
            )


def pause_update(state: Mapping[str, Any], now: Callable[[], float]) -> dict[str, float]:
    """Port of nodeHelpers.ts `pauseUpdate`: the state update an interrupt node returns once it resumes — how long
    the run sat paused (from `lastActiveAt`, when the last node finished, to now) and the new `lastActiveAt`."""
    resumed_at = now()
    last_active_at = state.get("lastActiveAt") or 0
    paused_ms = max(0, resumed_at - last_active_at) if last_active_at > 0 else 0
    return {"pausedMs": paused_ms, "lastActiveAt": resumed_at}
