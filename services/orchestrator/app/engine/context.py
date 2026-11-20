"""Run variable bag (port of apps/extension/src/runtime/context.ts, itself ported from the orka orchestrator).

Variables are keyed by their full dotted name (e.g. "Local.WorkItem", "System.LastMessage.Text"). set-variable
mutates it; agent output merges into it; condition predicates read from it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from app.spec.jscompat import NUMERIC_LITERAL_RE, QUOTED_RE, UNDEFINED, js_number_literal, js_str, js_trim

LAST_MESSAGE_KEY: Final = "System.LastMessage.Text"
"""The conventional "last assistant message" slot."""


class RunContext:
    def __init__(self, initial: Mapping[str, Any] | None = None) -> None:
        self._vars: dict[str, Any] = dict(initial) if initial else {}

    def _lookup(self, name: str) -> Any:
        """Like `get`, but a missing variable reads as UNDEFINED (distinct from a variable holding None/null)."""
        if name in self._vars:
            return self._vars[name]
        # tolerate a leading "=" or surrounding spaces
        trimmed = js_trim(name)
        if trimmed.startswith("="):
            trimmed = trimmed[1:]
        return self._vars.get(trimmed, UNDEFINED)

    def get(self, name: str) -> Any:
        """The variable's value, or None when it isn't set."""
        value = self._lookup(name)
        return None if value is UNDEFINED else value

    def set(self, name: str, value: Any) -> None:
        self._vars[js_trim(name)] = value

    def reset(self, name: str) -> None:
        self._vars[js_trim(name)] = ""

    def set_last_message(self, text: str) -> None:
        self.set(LAST_MESSAGE_KEY, text)

    def get_last_message(self) -> str:
        value = self.get(LAST_MESSAGE_KEY)
        return "" if value is None else js_str(value)

    def interpolate(self, expr: Any) -> Any:
        """Resolves a PowerFx-ish value expression used by set-variable.value.

        - "=System.LastMessage.Text" / "=Local.Foo" -> the variable's value (unknown paths resolve to "")
        - '="literal"' / "='literal'" -> the literal string
        - "=42" / "=-1.5" -> the number
        - "literal" (no leading "=") -> the trimmed string
        - a non-string -> returned unchanged
        """
        if not isinstance(expr, str):
            return expr
        raw = js_trim(expr)
        if not raw.startswith("="):
            return raw
        body = js_trim(raw[1:])
        quoted = QUOTED_RE.fullmatch(body)
        if quoted:
            if quoted.group(1) is not None:
                return quoted.group(1)
            return quoted.group(2) if quoted.group(2) is not None else ""
        if NUMERIC_LITERAL_RE.fullmatch(body):
            return js_number_literal(body)
        resolved = self._lookup(body)
        return "" if resolved is UNDEFINED else resolved

    def to_bag(self) -> dict[str, Any]:
        """A shallow copy of every variable."""
        return dict(self._vars)
