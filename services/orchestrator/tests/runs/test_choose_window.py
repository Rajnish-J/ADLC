"""Which VS Code window a requested run goes to when the caller didn't pick one."""

from __future__ import annotations

from app.harnesses import Window
from app.runs.service import choose_window


def win(client_id: str, *harnesses: str) -> Window:
    return Window(client_id=client_id, harnesses=set(harnesses))


def test_the_window_with_the_repo_open_wins_over_a_newer_one() -> None:
    fitting = [win("other-folder-01", "claude-code"), win("repo-window-01", "claude-code")]
    assert choose_window(fitting, {"claude-code"}, ["repo-window-01"]) == "repo-window-01"


def test_a_repo_window_that_lacks_a_harness_is_not_in_fitting_and_is_skipped() -> None:
    fitting = [win("other-folder-01", "claude-code", "codex")]
    assert choose_window(fitting, {"claude-code", "codex"}, ["repo-window-01"]) == "other-folder-01"


def test_without_a_repo_window_the_old_rules_apply() -> None:
    two = [win("window-a-0001", "claude-code"), win("window-b-0001", "claude-code")]
    assert choose_window(two, {"claude-code"}, []) is None
    assert choose_window(two[:1], {"claude-code"}, []) == "window-a-0001"
    assert choose_window(two, {"claude-code", "codex"}, []) == "window-a-0001"
    assert choose_window([], {"claude-code"}, ["repo-window-01"]) is None
