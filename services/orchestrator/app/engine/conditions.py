"""Condition predicate evaluation (port of apps/extension/src/runtime/conditions.ts, from the orka orchestrator).

A small, safe subset of PowerFx — no eval(), no function calls. Deliberately forgiving: anything unparseable
resolves falsy so a malformed predicate can't crash a run. Used for handoff routing (condition nodes); an empty
predicate (ELSE) is always true.

    Local.X = "FEATURE"      (= and == both mean equality, PowerFx style)
    Local.Count >= 8         (numeric comparison when both sides are numbers)
    Local.A <> "x"           (<> and != both mean inequality)
    <expr> And <expr>        (also &&)
    <expr> Or  <expr>        (also ||)

Quirks kept from the original (they are what runs today): `Or` splits before `And`, quotes are not respected when
splitting, there is no `Not(...)` (it reads as an unknown variable, so it is false), and a leading `=` in front of a
comparison (`=Local.X = "y"`) is always false — a leading `=` only works on a bare operand (`=Local.Flag`).
"""

from __future__ import annotations

import math
import re
from typing import Any, Final, Literal

from app.engine.context import RunContext
from app.spec.jscompat import (
    JS_WS,
    NUMERIC_LITERAL_RE,
    QUOTED_RE,
    js_number_literal,
    js_str,
    js_to_number,
    js_trim,
    js_truthy,
    utf16_key,
)

Operator = Literal["=", "==", "<>", "!=", ">=", "<=", ">", "<"]

# Scan order matters: two-character operators are found before their one-character prefixes.
OPERATORS: Final[tuple[Operator, ...]] = ("==", ">=", "<=", "<>", "!=", "=", ">", "<")

_KEYWORD_RES: Final[dict[str, re.Pattern[str]]] = {
    "Or": re.compile(f"{JS_WS}+Or{JS_WS}+", re.IGNORECASE | re.ASCII),
    "And": re.compile(f"{JS_WS}+And{JS_WS}+", re.IGNORECASE | re.ASCII),
    "||": re.compile(f"{JS_WS}*\\|\\|{JS_WS}*"),
    "&&": re.compile(f"{JS_WS}*&&{JS_WS}*"),
}


def evaluate_condition(predicate: str | None, ctx: RunContext) -> bool:
    if predicate is None:
        predicate = ""
    elif not isinstance(predicate, str):
        predicate = js_str(predicate)
    expr = js_trim(predicate)
    if not expr:
        return True  # ELSE / unconditional

    or_parts = _split_on_keywords(expr, ("Or", "||"))
    if len(or_parts) > 1:
        return any(evaluate_condition(p, ctx) for p in or_parts)

    and_parts = _split_on_keywords(expr, ("And", "&&"))
    if len(and_parts) > 1:
        return all(evaluate_condition(p, ctx) for p in and_parts)

    return _evaluate_comparison(expr, ctx)


def _split_on_keywords(expr: str, keywords: tuple[str, ...]) -> list[str]:
    for kw in keywords:
        pattern = _KEYWORD_RES[kw]
        if pattern.search(expr):
            return [part for part in (js_trim(s) for s in pattern.split(expr)) if part]
    return [expr]


def _evaluate_comparison(expr: str, ctx: RunContext) -> bool:
    for op in OPERATORS:
        idx = expr.find(op)
        if idx == -1:
            continue
        lhs = js_trim(expr[:idx])
        rhs = js_trim(expr[idx + len(op) :])
        if not lhs or not rhs:
            continue
        return _compare(_resolve_operand(lhs, ctx), _resolve_operand(rhs, ctx), op)
    val = _resolve_operand(expr, ctx)
    if not js_truthy(val):
        return False
    return not (isinstance(val, str) and val in ("0", "false"))


def _resolve_operand(token: str, ctx: RunContext) -> Any:
    t = js_trim(token)
    if t.startswith("="):
        t = t[1:]
    t = js_trim(t)
    quoted = QUOTED_RE.fullmatch(t)
    if quoted:
        if quoted.group(1) is not None:
            return quoted.group(1)
        return quoted.group(2) if quoted.group(2) is not None else ""
    if NUMERIC_LITERAL_RE.fullmatch(t):
        return js_number_literal(t)
    if t == "true":
        return True
    if t == "false":
        return False
    return ctx.get(t)


def _is_js_object(v: Any) -> bool:
    """`typeof v === 'object'` — null, arrays and objects."""
    return v is None or not isinstance(v, (str, bool, int, float))


def _compare(left: Any, right: Any, op: Operator) -> bool:
    both_numeric = (
        not _is_js_object(left)
        and not _is_js_object(right)
        and left != ""
        and right != ""
        and not math.isnan(js_to_number(left))
        and not math.isnan(js_to_number(right))
    )
    if both_numeric:
        a = js_to_number(left)
        b = js_to_number(right)
        return _apply(a, b, op)

    sa = utf16_key("" if left is None else js_str(left))
    sb = utf16_key("" if right is None else js_str(right))
    return _apply(sa, sb, op)


def _apply(a: Any, b: Any, op: Operator) -> bool:
    if op in ("=", "=="):
        return bool(a == b)
    if op in ("<>", "!="):
        return bool(a != b)
    if op == ">":
        return bool(a > b)
    if op == "<":
        return bool(a < b)
    if op == ">=":
        return bool(a >= b)
    if op == "<=":
        return bool(a <= b)
    return False
