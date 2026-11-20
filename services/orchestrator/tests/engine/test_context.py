from app.engine.context import LAST_MESSAGE_KEY, RunContext


def test_get_tolerates_surrounding_spaces_and_a_leading_equals():
    ctx = RunContext({"Local.X": 1})
    assert ctx.get("Local.X") == 1
    assert ctx.get("  Local.X ") == 1
    assert ctx.get("=Local.X") == 1
    assert ctx.get(" =Local.X") == 1
    assert ctx.get("= Local.X") is None  # only trimmed before the "=" is dropped, as in the TS
    assert ctx.get("Local.Missing") is None


def test_exact_key_wins_over_the_trimmed_one():
    ctx = RunContext({" a ": "spaced", "a": "plain"})
    assert ctx.get(" a ") == "spaced"


def test_set_and_reset_trim_the_name():
    ctx = RunContext()
    ctx.set("  Local.Y  ", "v")
    assert ctx.to_bag() == {"Local.Y": "v"}
    ctx.reset(" Local.Y")
    assert ctx.get("Local.Y") == ""


def test_initial_values_are_copied():
    initial = {"a": 1}
    ctx = RunContext(initial)
    ctx.set("b", 2)
    assert initial == {"a": 1}
    bag = ctx.to_bag()
    bag["c"] = 3
    assert ctx.get("c") is None


def test_last_message():
    ctx = RunContext()
    assert ctx.get_last_message() == ""
    ctx.set_last_message("hello")
    assert ctx.get(LAST_MESSAGE_KEY) == "hello"
    assert ctx.get_last_message() == "hello"
    ctx.set(LAST_MESSAGE_KEY, 5)
    assert ctx.get_last_message() == "5"
    ctx.set(LAST_MESSAGE_KEY, 2.0)
    assert ctx.get_last_message() == "2"  # String(2) in JS
    ctx.set(LAST_MESSAGE_KEY, True)
    assert ctx.get_last_message() == "true"
    ctx.set(LAST_MESSAGE_KEY, None)
    assert ctx.get_last_message() == ""
    ctx.set(LAST_MESSAGE_KEY, {"a": 1})
    assert ctx.get_last_message() == "[object Object]"


def test_interpolate_passes_non_strings_through():
    ctx = RunContext()
    assert ctx.interpolate(5) == 5
    assert ctx.interpolate(None) is None
    obj = {"a": 1}
    assert ctx.interpolate(obj) is obj


def test_interpolate_without_equals_is_a_trimmed_literal():
    ctx = RunContext({"Local.X": "x"})
    assert ctx.interpolate("  Local.X  ") == "Local.X"
    assert ctx.interpolate('"quoted"') == '"quoted"'


def test_interpolate_quoted_literals():
    ctx = RunContext()
    assert ctx.interpolate('="literal"') == "literal"
    assert ctx.interpolate("='single'") == "single"
    assert ctx.interpolate('= "spaced" ') == "spaced"
    assert ctx.interpolate('=""') == ""
    assert ctx.interpolate('="a"b"') == 'a"b'
    assert ctx.interpolate('="unterminated') == ""  # an unknown variable named `"unterminated`


def test_interpolate_numbers():
    ctx = RunContext()
    assert ctx.interpolate("=42") == 42
    assert isinstance(ctx.interpolate("=42"), int)
    assert ctx.interpolate("=-3.5") == -3.5
    assert ctx.interpolate("=5.0") == 5
    assert ctx.interpolate("=1e3") == ""  # not the numeric pattern → variable lookup → unknown


def test_interpolate_variables():
    ctx = RunContext({"Local.Foo": [1, 2], "System.LastMessage.Text": "last", "Local.Null": None})
    assert ctx.interpolate("=Local.Foo") == [1, 2]
    assert ctx.interpolate("=System.LastMessage.Text") == "last"
    assert ctx.interpolate("=Local.Unknown") == ""
    # A variable explicitly holding null resolves to null (only `undefined` becomes '').
    assert ctx.interpolate("=Local.Null") is None
    assert ctx.interpolate("==Local.Foo") == [1, 2]  # get() tolerates the second "="


def test_interpolate_does_not_treat_unicode_digits_as_numbers():
    ctx = RunContext({"٣": "arabic three"})
    assert ctx.interpolate("=٣") == "arabic three"
