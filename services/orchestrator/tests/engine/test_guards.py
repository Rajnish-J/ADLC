import math

import pytest

from app.engine.guards import BudgetExceededError, GuardState, pause_update
from app.spec.models import DEFAULT_RUN_BUDGET, RunBudget


def budget(**kw):
    return RunBudget(**{"maxSteps": 10, "timeoutMs": 1_000, **kw})


# --- runIsolation.test.ts "GuardState time budget" -------------------------------------------------------------


def test_time_spent_paused_is_excluded_from_the_time_limit():
    guard = GuardState(budget(), 0)
    guard.tick(500)
    guard.add_paused_ms(60 * 60 * 1000)  # an hour awaiting approval
    guard.tick(60 * 60 * 1000 + 900)


def test_active_time_over_the_limit_still_trips_the_budget():
    guard = GuardState(budget(), 0, paused_ms=5_000)
    with pytest.raises(BudgetExceededError) as err:
        guard.tick(7_000)
    assert err.value.cause == "timeout"
    assert str(err.value) == "Exceeded 1s run-time limit (time awaiting approval excluded)."


# --- step budget (mockRuntime/langGraphRuntime "goto loop hits the max-step budget") -----------------------------


def test_max_steps_trips_on_the_step_after_the_budget():
    guard = GuardState(budget(maxSteps=5, timeoutMs=60_000), 0)
    for _ in range(5):
        guard.tick(1)
    assert guard.step_count == 5
    with pytest.raises(BudgetExceededError) as err:
        guard.tick(1)
    assert err.value.cause == "max-steps"
    assert err.value.message == "Halted after 5 node executions — check for an unbounded goto loop."
    assert "node executions" in str(err.value).lower()
    assert guard.step_count == 6  # the failing tick still counts, as in the TS


def test_max_steps_is_checked_before_the_timeout():
    guard = GuardState(budget(maxSteps=0), 0)
    with pytest.raises(BudgetExceededError) as err:
        guard.tick(10**9)
    assert err.value.cause == "max-steps"


def test_timeout_boundary_is_strictly_greater_than():
    guard = GuardState(budget(), 100)
    guard.tick(1_100)  # exactly the limit: fine
    with pytest.raises(BudgetExceededError):
        guard.tick(1_101)


@pytest.mark.parametrize(
    ("timeout_ms", "seconds"),
    [(300_000, "300"), (1_500, "2"), (2_500, "3"), (499, "0"), (500, "1")],
)
def test_timeout_message_rounds_like_math_round(timeout_ms, seconds):
    guard = GuardState(budget(timeoutMs=timeout_ms), 0)
    with pytest.raises(BudgetExceededError) as err:
        guard.tick(timeout_ms + 1)
    assert str(err.value) == f"Exceeded {seconds}s run-time limit (time awaiting approval excluded)."


# --- tokens ----------------------------------------------------------------------------------------------------


def test_tokens_unbounded_when_max_tokens_is_zero_or_unset():
    for b in (budget(maxTokens=0), budget(), DEFAULT_RUN_BUDGET):
        guard = GuardState(b, 0)
        guard.add_tokens(10**9, 10**9)
        assert guard.token_count == 2 * 10**9


def test_token_budget():
    guard = GuardState(budget(maxTokens=10), 0)
    guard.add_tokens(4, 6)  # exactly the budget: fine
    with pytest.raises(BudgetExceededError) as err:
        guard.add_tokens(1, 0)
    assert err.value.cause == "max-tokens"
    assert str(err.value) == "Halted after 11 tokens — exceeded the 10-token per-run budget."


def test_missing_or_nan_token_counts_are_zero():
    guard = GuardState(budget(), 0)
    guard.add_tokens(None, math.nan)
    guard.add_tokens(3, None)
    assert guard.token_count == 3


# --- paused time -----------------------------------------------------------------------------------------------


def test_add_paused_ms_ignores_non_positive_and_non_finite():
    guard = GuardState(budget(), 0)
    for ms in (-5, 0, math.nan, math.inf):
        guard.add_paused_ms(ms)
    assert guard.paused_ms == 0
    guard.add_paused_ms(250)
    guard.add_paused_ms(0.5)
    assert guard.paused_ms == 250.5


# --- resume / reconstruct --------------------------------------------------------------------------------------


def test_resume_seeds_counters():
    guard = GuardState(budget(maxSteps=3), 999, steps=2, tokens=7, started_at=10, paused_ms=4)
    assert (guard.step_count, guard.token_count, guard.started_at, guard.paused_ms) == (2, 7, 10, 4)
    guard.tick(11)
    with pytest.raises(BudgetExceededError):
        guard.tick(12)


def test_fresh_guard_starts_now():
    guard = GuardState(budget(), 1234)
    assert (guard.step_count, guard.token_count, guard.started_at, guard.paused_ms) == (0, 0, 1234, 0)


def test_from_state_matches_node_helpers_reconstruct():
    calls = []

    def now():
        calls.append(1)
        return 5_000

    state = {"stepCount": 3, "tokenCount": 40, "startedAt": 1_000, "pausedMs": 200, "vars": {}}
    guard = GuardState.from_state(budget(), state, now)
    assert (guard.step_count, guard.token_count, guard.started_at, guard.paused_ms) == (3, 40, 1_000, 200)
    assert calls == []  # a checkpointed startedAt is used as-is

    for empty in ({}, {"startedAt": 0}):
        fresh = GuardState.from_state(budget(), empty, now)
        assert (fresh.step_count, fresh.token_count, fresh.started_at, fresh.paused_ms) == (0, 0, 5_000, 0)


def test_from_state_accepts_a_budget_dict():
    guard = GuardState.from_state({"maxSteps": 1, "timeoutMs": 10}, {"startedAt": 1}, lambda: 1)
    guard.tick(1)
    with pytest.raises(BudgetExceededError):
        guard.tick(1)


def test_pause_update():
    assert pause_update({"lastActiveAt": 1_000}, lambda: 4_000) == {"pausedMs": 3_000, "lastActiveAt": 4_000}
    assert pause_update({"lastActiveAt": 5_000}, lambda: 4_000) == {"pausedMs": 0, "lastActiveAt": 4_000}
    assert pause_update({}, lambda: 4_000) == {"pausedMs": 0, "lastActiveAt": 4_000}


def test_budget_exceeded_is_an_exception_with_a_cause():
    err = BudgetExceededError("boom", "timeout")
    assert isinstance(err, Exception)
    assert (str(err), err.message, err.cause) == ("boom", "boom", "timeout")
