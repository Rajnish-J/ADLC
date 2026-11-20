import pytest

from app.engine.conditions import evaluate_condition
from app.engine.context import RunContext


def ev(predicate, **vars):
    return evaluate_condition(predicate, RunContext({k.replace("__", "."): v for k, v in vars.items()}))


@pytest.mark.parametrize("predicate", [None, "", "   ", "\n\t"])
def test_empty_predicate_is_else_and_always_true(predicate):
    assert evaluate_condition(predicate, RunContext()) is True


def test_handoff_route_predicate():
    # mockRuntime/langGraphRuntime "handoff routes to the matching branch by agent output".
    assert ev('Local.RouterOutput = "FEATURE"', Local__RouterOutput="FEATURE") is True
    assert ev('Local.RouterOutput = "FEATURE"', Local__RouterOutput="BUG") is False
    assert ev('Local.RouterOutput = "FEATURE"') is False


@pytest.mark.parametrize("op", ["=", "=="])
def test_equality_operators(op):
    assert ev(f'Local.X {op} "FEATURE"', Local__X="FEATURE") is True
    assert ev(f"Local.X {op} 'FEATURE'", Local__X="FEATURE") is True
    assert ev(f'Local.X {op} "feature"', Local__X="FEATURE") is False


@pytest.mark.parametrize("op", ["<>", "!="])
def test_inequality_operators(op):
    assert ev(f'Local.A {op} "x"', Local__A="y") is True
    assert ev(f'Local.A {op} "x"', Local__A="x") is False
    assert ev(f'Local.Missing {op} "x"') is True


def test_numeric_comparisons_coerce_numeric_strings():
    assert ev("Local.Count >= 8", Local__Count=8) is True
    assert ev("Local.Count >= 8", Local__Count=7) is False
    assert ev("Local.Count > 8", Local__Count="10") is True  # numeric, not "10" > "8" as strings
    assert ev("Local.Count < 8", Local__Count="10") is False
    assert ev("Local.Count <= 8.5", Local__Count=8.5) is True
    assert ev("Local.Count = 8", Local__Count="8.0") is True
    assert ev('Local.Count = "5"', Local__Count=5) is True
    assert ev("Local.Count = -2", Local__Count=-2) is True


def test_js_number_coercion_quirks():
    assert ev("Local.Flag = 1", Local__Flag=True) is True  # Number(true) === 1
    assert ev("Local.Flag > false", Local__Flag=True) is True
    assert ev("Local.Blank = 0", Local__Blank="   ") is True  # Number('   ') === 0 ('   ' !== '')
    assert ev("Local.Hex = 16", Local__Hex="0x10") is True
    assert ev("Local.Big > 1000", Local__Big="Infinity") is True
    assert ev("Local.X = 1000", Local__X="1_000") is False  # no underscores in JS numbers
    # "nan" is not a number in JS, so this is the string compare "nan" > "99" (true), not NaN > 99 (false).
    assert ev("Local.X > 99", Local__X="nan") is True


def test_empty_string_is_never_numeric():
    assert ev('Local.Missing = ""') is True  # String(undefined ?? '') === ''
    assert ev("Local.Empty = 0", Local__Empty="") is False  # '' vs '0' as strings


def test_string_comparison_fallback_uses_js_ordering():
    assert ev('Local.A > "a"', Local__A="b") is True
    assert ev('Local.A < "B"', Local__A="a") is False  # 'a' (0x61) > 'B' (0x42)
    assert ev('Local.A >= "abc"', Local__A="abd") is True
    # JS compares UTF-16 code units: U+FFFF sorts after a surrogate pair (0xD83D...), unlike code points.
    assert evaluate_condition("Local.A > Local.B", RunContext({"Local.A": "￿", "Local.B": "\U0001f600"})) is True


def test_objects_compare_as_strings():
    assert ev('Local.O = "[object Object]"', Local__O={"a": 1}) is True
    assert ev('Local.L = "1,2"', Local__L=[1, 2]) is True
    # Arrays are typeof 'object' (never numeric), but String([5]) === String(5), so the string fallback matches.
    assert ev("Local.L = 5", Local__L=[5]) is True
    assert ev("Local.L > 4", Local__L=[5]) is True  # "5" > "4" as strings
    assert ev("Local.L > 40", Local__L=[5]) is True  # "5" > "40" as strings — numerically it would be false


def test_booleans():
    assert ev("Local.Flag = true", Local__Flag=True) is True
    assert ev("Local.Flag = false", Local__Flag=False) is True
    assert ev("Local.Flag = true", Local__Flag="true") is True  # string "true" vs boolean → strings "true"
    assert ev("Local.Flag = true", Local__Flag=False) is False


def test_bare_operand_truthiness():
    assert ev("Local.Flag", Local__Flag=True) is True
    assert ev("Local.Flag", Local__Flag="yes") is True
    assert ev("Local.Flag", Local__Flag=[]) is True  # objects/arrays are truthy in JS
    assert ev("Local.Flag", Local__Flag={}) is True
    for falsy in ["0", "false", 0, 0.0, "", False, None]:
        assert ev("Local.Flag", Local__Flag=falsy) is False, falsy
    assert ev("Local.Missing") is False
    assert ev("true") is True
    assert ev("false") is False
    assert ev("1") is True
    assert ev("0") is False
    assert ev('"0"') is False
    assert ev('"FALSE"') is True  # only the exact string 'false' is falsy


def test_leading_equals():
    assert ev("=Local.Flag", Local__Flag=True) is True
    # A leading "=" before a comparison: indexOf('=') hits position 0 (empty lhs), so no operator applies and the
    # whole text is looked up as one variable name — always false.
    assert ev('=Local.X = "y"', Local__X="y") is False
    assert ev("=Local.Count >= 1", Local__Count=5) is True  # '>=' is scanned before '=' so this one works


def test_not_is_not_supported():
    assert ev("=Not(Local.GateResult.pass)", Local__GateResult__pass=False) is False
    assert ev("Not(Local.GateResult.pass)", Local__GateResult__pass=True) is False


@pytest.mark.parametrize("kw", ["And", "and", "AND", "&&"])
def test_and(kw):
    assert ev(f'Local.A = "1" {kw} Local.B = "2"', Local__A="1", Local__B="2") is True
    assert ev(f'Local.A = "1" {kw} Local.B = "2"', Local__A="1", Local__B="3") is False


@pytest.mark.parametrize("kw", ["Or", "or", "OR", "||"])
def test_or(kw):
    assert ev(f'Local.A = "1" {kw} Local.B = "2"', Local__A="0", Local__B="2") is True
    assert ev(f'Local.A = "1" {kw} Local.B = "2"', Local__A="0", Local__B="0") is False


def test_symbolic_operators_need_no_spaces_but_keywords_do():
    assert ev('Local.A="1"&&Local.B="2"', Local__A="1", Local__B="2") is True
    assert ev('Local.A="1"||Local.B="2"', Local__A="0", Local__B="2") is True
    # "AndLocal" is not a keyword (needs whitespace on both sides): one comparison, rhs '"1"AndLocal.B="2"'.
    assert ev('Local.A="1"AndLocal.B="2"', Local__A="1", Local__B="2") is False


def test_or_binds_looser_than_and():
    assert ev("Local.A And Local.B Or Local.C", Local__A=False, Local__B=True, Local__C=True) is True
    assert ev("Local.A And Local.B Or Local.C", Local__A=True, Local__B=False, Local__C=False) is False
    assert ev("Local.A Or Local.B And Local.C", Local__A=True, Local__B=False, Local__C=False) is True


def test_quotes_are_not_respected_when_splitting():
    # 'Local.X = "a Or b"' splits into 'Local.X = "a' and 'b"' — neither holds.
    assert ev('Local.X = "a Or b"', Local__X="a Or b") is False


def test_unparseable_is_false():
    assert ev("Local.X ===", Local__X="a") is False
    # ...mostly: '===' is '==' with rhs '=', which resolves to the variable '' (unset) → '' === '' when X is unset.
    assert ev("Local.X ===") is True
    assert ev("((garbage") is False
    assert ev(">= 5") is False
    assert ev("x ||") is False


def test_non_string_predicate_is_stringified():
    assert evaluate_condition(1, RunContext()) is True  # type: ignore[arg-type]
    assert evaluate_condition(0, RunContext()) is False  # type: ignore[arg-type]
