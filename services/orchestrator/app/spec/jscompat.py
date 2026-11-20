"""JavaScript value semantics the ported TypeScript relies on.

The workflow engine and spec validation were ported from TypeScript, where `String(x)`, `Number(x)`, truthiness,
`trim()`, `Set` membership and `<`/`>` on strings all behave differently from their Python look-alikes. These helpers
reproduce the JS behaviour so the ports return the same answers (and the same user-facing messages) as the originals.
"""

from __future__ import annotations

import math
import re
from decimal import Decimal
from typing import Any, Final


class _Undefined:
    """JS `undefined` — a missing property, as distinct from an explicit JSON `null` (Python `None`)."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "UNDEFINED"

    def __bool__(self) -> bool:
        return False


UNDEFINED: Final = _Undefined()

# ECMAScript WhiteSpace + LineTerminator: what String.prototype.trim() strips and regex `\s` matches. Python's
# str.strip()/`\s` differ (they include U+001C-U+001F and U+0085, and miss U+FEFF).
# Built from code points so no formatter turns escapes into invisible literal characters.
JS_WHITESPACE: Final = "".join(
    chr(c)
    for c in (
        *(0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680),
        *range(0x2000, 0x200B),
        *(0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF),
    )
)
# A regex character class matching one JS whitespace character.
JS_WS: Final = "[" + "".join(f"\\u{ord(c):04x}" for c in JS_WHITESPACE) + "]"

# JS `.` (no `s` flag) matches anything but a line terminator.
_JS_DOT: Final = "[^\\n\\r\\u2028\\u2029]"
# `/^"(.*)"$|^'(.*)'$/` — use with fullmatch (Python's `$` also matches before a trailing newline; JS's does not).
QUOTED_RE: Final = re.compile(f"\"({_JS_DOT}*)\"|'({_JS_DOT}*)'")
# `/^-?\d+(\.\d+)?$/` — JS `\d` is ASCII-only; Python's matches any Unicode digit.
NUMERIC_LITERAL_RE: Final = re.compile(r"-?[0-9]+(?:\.[0-9]+)?")

_STR_DECIMAL_RE: Final = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
_RADIX_RES: Final = (
    (re.compile(r"0[xX]([0-9a-fA-F]+)"), 16),
    (re.compile(r"0[oO]([0-7]+)"), 8),
    (re.compile(r"0[bB]([01]+)"), 2),
)
_MAX_SAFE_INTEGER: Final = 2**53 - 1


def js_trim(s: str) -> str:
    """`String.prototype.trim()`."""
    return s.strip(JS_WHITESPACE)


def js_truthy(v: Any) -> bool:
    """`Boolean(v)`. Unlike Python, empty arrays/objects are truthy and NaN is falsy."""
    if v is None or v is UNDEFINED:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v != 0
    if isinstance(v, float):
        return not (v == 0 or math.isnan(v))
    if isinstance(v, str):
        return v != ""
    return True


def js_number_to_string(x: float) -> str:
    """`Number.prototype.toString()` for a double: shortest round-trip digits, JS exponent thresholds."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    parts = Decimal(repr(abs(x))).normalize().as_tuple()
    digits = "".join(str(d) for d in parts.digits)
    exponent = parts.exponent
    assert isinstance(exponent, int)
    k = len(digits)
    n = k + exponent  # value = 0.<digits> * 10**n
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mantissa = digits[0] + (f".{digits[1:]}" if k > 1 else "")
        out = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + out


def js_str(v: Any) -> str:
    """`String(v)` (also what a template literal `${v}` produces)."""
    if v is UNDEFINED:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v) if abs(v) <= _MAX_SAFE_INTEGER else js_number_to_string(float(v))
    if isinstance(v, float):
        return js_number_to_string(v)
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        # Array.prototype.join: null/undefined elements become ''.
        return ",".join("" if x is None or x is UNDEFINED else js_str(x) for x in v)
    return "[object Object]"


def js_to_number(v: Any) -> float:
    """`Number(v)`. `None` is treated as `undefined` (NaN) — it is what a missing RunContext variable reads as."""
    if v is None or v is UNDEFINED:
        return math.nan
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, int):
        try:
            return float(v)
        except OverflowError:
            return math.inf if v > 0 else -math.inf
    if isinstance(v, float):
        return v
    if isinstance(v, str):
        s = js_trim(v)
        if s == "":
            return 0.0
        if _STR_DECIMAL_RE.fullmatch(s):
            if s.endswith("Infinity"):
                return -math.inf if s.startswith("-") else math.inf
            return float(s)
        for pattern, base in _RADIX_RES:
            m = pattern.fullmatch(s)
            if m:
                try:
                    return float(int(m.group(1), base))
                except OverflowError:
                    return math.inf
        return math.nan
    if isinstance(v, (list, tuple)):
        return js_to_number(js_str(v))
    return math.nan


def js_number_literal(text: str) -> int | float:
    """`Number(text)` for a string already matching NUMERIC_LITERAL_RE. Integral values come back as `int` so they
    serialize the way JS serializes them (`5`, not `5.0`)."""
    f = float(text)
    if f.is_integer() and abs(f) <= _MAX_SAFE_INTEGER:
        return int(f)
    return f


def js_round(x: float) -> int:
    """`Math.round` — halves round toward +Infinity (Python's round() is banker's rounding)."""
    r = math.floor(x)
    return int(r + 1 if x - r >= 0.5 else r)


def js_key(v: Any) -> tuple[Any, ...]:
    """A hashable key with JS `Set`/`Map` (SameValueZero) identity: `1` and `"1"` differ, `true` and `1` differ,
    `null` and `undefined` differ, objects compare by reference."""
    if isinstance(v, str):
        return ("s", v)
    if isinstance(v, bool):
        return ("b", v)
    if isinstance(v, (int, float)):
        if isinstance(v, float) and math.isnan(v):
            return ("nan",)
        return ("n", v)
    if v is None:
        return ("null",)
    if v is UNDEFINED:
        return ("undefined",)
    return ("o", id(v))


def utf16_key(s: str) -> bytes:
    """Sort key giving JS string ordering (UTF-16 code units, not code points)."""
    return s.encode("utf-16-be", "surrogatepass")
