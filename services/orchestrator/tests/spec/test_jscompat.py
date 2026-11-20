import math

import pytest

from app.spec.jscompat import (
    UNDEFINED,
    js_key,
    js_number_to_string,
    js_round,
    js_str,
    js_to_number,
    js_trim,
    js_truthy,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.0, "0"),
        (-0.0, "0"),
        (5.0, "5"),
        (0.1, "0.1"),
        (1.5, "1.5"),
        (-2.25, "-2.25"),
        (100.0, "100"),
        (1e16, "10000000000000000"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (1.5e21, "1.5e+21"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (1.25e-7, "1.25e-7"),
        (123456.789, "123456.789"),
        (math.inf, "Infinity"),
        (-math.inf, "-Infinity"),
        (math.nan, "NaN"),
    ],
)
def test_number_to_string(value, expected):
    assert js_number_to_string(value) == expected


def test_js_str():
    assert js_str(UNDEFINED) == "undefined"
    assert js_str(None) == "null"
    assert js_str(True) == "true"
    assert js_str(7) == "7"
    assert js_str(7.0) == "7"
    assert js_str("s") == "s"
    assert js_str([1, None, "a", [2, 3]]) == "1,,a,2,3"
    assert js_str({"a": 1}) == "[object Object]"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", 0.0),
        ("  \n", 0.0),
        (" 12 ", 12.0),
        ("1e3", 1000.0),
        (".5", 0.5),
        ("5.", 5.0),
        ("+3", 3.0),
        ("0x1F", 31.0),
        ("0o17", 15.0),
        ("0b101", 5.0),
        ("-Infinity", -math.inf),
        (True, 1.0),
        (False, 0.0),
        ([7], 7.0),
        ([], 0.0),
    ],
)
def test_to_number(value, expected):
    assert js_to_number(value) == expected


@pytest.mark.parametrize("value", ["abc", "1_000", "inf", "nan", "-0x10", "1,2", None, UNDEFINED, {}, [1, 2], "٣"])
def test_to_number_nan(value):
    assert math.isnan(js_to_number(value))


def test_trim_uses_js_whitespace():
    assert js_trim("﻿ a 　") == "a"
    assert js_trim("\x1ca\x1c") == "\x1ca\x1c"  # Python's strip() would remove U+001C


def test_truthy():
    for v in ([], {}, "0", "false", 1, -1.5, "x"):
        assert js_truthy(v) is True
    for v in ("", 0, 0.0, math.nan, None, UNDEFINED, False):
        assert js_truthy(v) is False


@pytest.mark.parametrize(
    ("x", "expected"), [(0.5, 1), (1.5, 2), (2.5, 3), (-2.5, -2), (-0.4, 0), (0.49999999999999994, 0)]
)
def test_round(x, expected):
    assert js_round(x) == expected


def test_key_follows_same_value_zero():
    assert js_key(1) == js_key(1.0)
    assert js_key(1) != js_key("1")
    assert js_key(True) != js_key(1)
    assert js_key(None) != js_key(UNDEFINED)
    assert js_key(math.nan) == js_key(float("nan"))
    a, b = {}, {}
    assert js_key(a) == js_key(a)
    assert js_key(a) != js_key(b)
