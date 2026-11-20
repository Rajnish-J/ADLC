"""The run-finished callback retries until the gateway answers, marks the run once it has, and stops on a 404."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app.engine import runner


class FakeConn:
    def __init__(self, marked: list[Any]) -> None:
        self.marked = marked

    async def execute(self, stmt: Any) -> None:
        self.marked.append(stmt)


def fake_runtime(statuses: list[int | Exception]) -> tuple[Any, list[str]]:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        nxt = statuses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return httpx.Response(nxt, json={})

    rt = SimpleNamespace(
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        settings=SimpleNamespace(API_URL="http://gw", ORCHESTRATOR_TOKEN="tok"),
    )
    return rt, calls


@pytest.fixture
def marked(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    out: list[Any] = []

    @asynccontextmanager
    async def transaction() -> Any:
        yield FakeConn(out)

    monkeypatch.setattr(runner, "transaction", transaction)
    return out


async def test_retries_until_the_gateway_answers_then_marks_the_run(marked: list[Any]) -> None:
    rt, calls = fake_runtime([httpx.ConnectError("refused"), 502, 200])
    assert await runner._notify_finished(rt, "run-1", backoff=(0, 0, 0, 0)) is True
    assert calls == ["http://gw/internal/runs/run-1/finished"] * 3
    assert len(marked) == 1


async def test_gives_up_quietly_and_leaves_the_run_for_the_sweeper(marked: list[Any]) -> None:
    rt, calls = fake_runtime([500, 500])
    assert await runner._notify_finished(rt, "run-1", backoff=(0, 0)) is False
    assert len(calls) == 2 and marked == []


async def test_a_run_the_gateway_does_not_know_is_not_retried(marked: list[Any]) -> None:
    rt, calls = fake_runtime([404, 200])
    assert await runner._notify_finished(rt, "run-1", backoff=(0, 0)) is False
    assert len(calls) == 1 and marked == []
