"""The stub gate fails empty output and reported failures, but not output that only mentions zero failures."""

from __future__ import annotations

import pytest

from app.gates.stub import StubGateEvaluator, reports_failure

# The Tester agent's report format (packages/core/agents/tester.md): its `## Failures` heading alone must not fail it.
TESTER_REPORT = """## Coverage
| Acceptance criterion | Test | Result |
|---|---|---|
| AC1 | `refund.test.ts › rejects over-refund` | pass |

## Suite
- `npm test -- refund` — 12 passed, 0 failed

## Failures
- none
"""


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "this design will FAIL review",
        "2 tests failed",
        "FAILED tests/test_api.py::test_login",
        "The build failed on lint.",
        "1 failure in the payments suite",
        "0 failed, but 3 tests failed in the retry",
        "## Suite\n- 11 passed, 1 failed\n\n## Failures\n"
        "- refund.test.ts › rejects over-refund — off by one — clamp it",
        "## Failures\n- none\n- `login.test.ts` — timeout — raise the limit",
    ],
)
def test_reports_a_failure(text: str) -> None:
    assert reports_failure(text)


@pytest.mark.parametrize(
    "text",
    [
        "All 42 tests pass, 0 failed.",
        "No failures. Coverage 91%.",
        "Ran 12 tests: passed=12 failed=0",
        "failures: 0",
        "The migration did not fail on the dev DB.",
        "Added a fail-safe around the retry and a failover path.",
        "Zero tests failed.",
        "Everything works without failing.",
        "Implemented the endpoint and its tests.",
        "Fixed the failing test in the payments suite.",
        TESTER_REPORT,
        "## Coverage\nAll covered.\n\n### Failures\nNone.\n",
        "## Failures\n- none | <test> — <cause> — <suggested fix>\n",
    ],
)
def test_passes_output_that_only_mentions_zero_failures(text: str) -> None:
    assert not reports_failure(text)


async def test_the_verdict_is_labelled_stub() -> None:
    gate = StubGateEvaluator()
    ok = await gate.evaluate(sdlc_step="test", output="All tests pass, 0 failed", query="")
    bad = await gate.evaluate(sdlc_step="test", output="3 tests failed", query="")
    assert ok["pass"] is True and ok["source"] == "stub"
    assert bad["pass"] is False and "reports a failure" in bad["reason"]
