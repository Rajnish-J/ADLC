"""When a run's VS Code window counts as gone, so the sweeper fails the run instead of leaving it "running"."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.engine.sweeper import WINDOW_GONE_AFTER, window_gone

NOW = datetime(2026, 11, 19, 13, 0, tzinfo=UTC)


def test_a_window_silent_for_longer_than_the_limit_is_gone_while_it_holds_a_step() -> None:
    assert window_gone(NOW - WINDOW_GONE_AFTER - timedelta(seconds=1), NOW, outstanding_step=True)


def test_a_window_that_reported_recently_is_not_gone() -> None:
    assert not window_gone(NOW - timedelta(minutes=2), NOW, outstanding_step=True)


def test_a_window_with_no_presence_at_all_is_gone() -> None:
    assert window_gone(None, NOW, outstanding_step=True)


def test_without_an_outstanding_step_the_run_is_left_alone() -> None:
    assert not window_gone(None, NOW, outstanding_step=False)
    assert not window_gone(NOW - timedelta(hours=3), NOW, outstanding_step=False)
