"""The in-run quality gate. Until a server-side evaluator (Azure AI Foundry / azure-ai-evaluation) is configured, the
orchestrator uses this stub — mirroring the extension's StubGateEvaluator: it passes unless the step's output is
empty or reports a failure, and every verdict is labelled `stub` so nobody mistakes it for a real evaluation.

Agents report failures in a `## Failures` section (see packages/core/agents/tester.md). When the output has one, its
items decide: `- none` passes, any real item fails. The rest of the text is then checked for loose failure wording."""

from __future__ import annotations

import re
from typing import Any

# Phrases that mention failing without reporting one ("0 failed", "no failures", "did not fail", "fail-safe",
# "fixed the failing test").
_BENIGN = re.compile(
    r"\b(?:0|no|zero|none)\s+(?:\w+\s+)?fail(?:ed|ures?|ing|s)?\b"
    r"|\bfail(?:ed|ures?|s)?\s*[:=]\s*0\b"
    r"|\b(?:not|never|didn'?t|did\s+not|won'?t|will\s+not|doesn'?t|does\s+not|without)\s+fail(?:ed|ures?|ing|s)?\b"
    r"|\bfail[- ]?(?:over|safe|fast)\b"
    r"|\bfix(?:ed|es|ing)?\s+(?:\w+\s+){0,3}?fail(?:ing|ed|ures?)\b"
    r"|\bpreviously\s+fail(?:ing|ed)\b",
    re.IGNORECASE,
)
_FAIL = re.compile(r"\bfail", re.IGNORECASE)
# A markdown heading named Failures (any level), and the next heading that ends its section.
_FAILURES_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]*fail(?:ures?|ed|ing)?\b[^\n]*$", re.IGNORECASE | re.MULTILINE)
_NEXT_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]", re.MULTILINE)


def _split_failures(text: str) -> tuple[list[str] | None, str]:
    """The items of every `## Failures` section (None when there is none) and the text with those sections cut."""
    items: list[str] | None = None
    rest: list[str] = []
    pos = 0
    for m in _FAILURES_HEADING.finditer(text):
        if m.start() < pos:
            continue
        rest.append(text[pos : m.start()])
        nxt = _NEXT_HEADING.search(text, m.end())
        end = nxt.start() if nxt else len(text)
        items = items if items is not None else []
        for line in text[m.end() : end].splitlines():
            item = re.sub(r"^[\s>*+-]*(?:\d+[.)]\s*)?", "", line).strip()
            if item and not item.startswith("```"):
                items.append(item)
        pos = end
    rest.append(text[pos:])
    return items, "".join(rest)


def _is_nothing(item: str) -> bool:
    first = item.split()[0].lower() if item.split() else ""
    return first in {"none", "none.", "n/a", "na", "nothing", "-", "—"} or bool(
        re.match(r"^no\s+failures?\b", item, re.IGNORECASE)
    )


def reports_failure(text: str) -> bool:
    """True when the text is empty or reports a failure (mentions of zero failures don't count)."""
    if not text.strip():
        return True
    items, rest = _split_failures(text)
    if items is not None and any(not _is_nothing(i) for i in items):
        return True
    return bool(_FAIL.search(_BENIGN.sub(" ", rest)))


class StubGateEvaluator:
    async def evaluate(self, *, sdlc_step: str, output: str, query: str) -> dict[str, Any]:
        bad = reports_failure(output or "")
        reason = (
            f"Stub gate ({sdlc_step}): the step's output is empty or reports a failure."
            if bad
            else f"Stub gate ({sdlc_step}): no evaluator is configured, so the output was only checked for failures."
        )
        return {"pass": not bad, "reason": reason, "perEvaluator": [], "source": "stub"}
