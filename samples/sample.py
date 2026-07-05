"""Module docstring with ) ] } brackets that must be ignored.

It spans multiple lines and contains a fake code block:
    def not_real(): return [1, 2, 3)   # deliberately unbalanced, inside the string
"""

import json


def greet(names):
    # build a greeting [list] for everyone )  — comment brackets ignored too
    greetings = {}
    for name in names:
        greetings[name] = f"Hello, {name}!"
    return [greetings[n] for n in names]


class Box:
    '''Triple-single docstring (also multi-line),
    spanning ] } ) lines that must not affect balance.'''

    def __init__(self, items):
        self.items = list(items)
        self.meta = {"kind": "box", "tags": ["a", "b"], "note": "has ) and ] inside"}

    def render(self):
        return json.dumps({"items": self.items, "n": len(self.items)})


# Keyword vocabulary sample: exercises every per-keyword mnemonic byte that
# isn't already covered above — from/import, global/nonlocal, and/or/not/is,
# with/as, lambda, elif/except/pass, assert, del/raise, True/False/None.
from collections import OrderedDict as OD

counter = 0


def process(items, flag):
    global counter
    if flag and not items:
        pass
    elif flag or (items is None):
        raise ValueError("items required")
    try:
        with open("data.txt") as fh:
            data = fh.read()
    except IOError:
        data = None
    assert data is not None, "must have data"

    def bump():
        nonlocal counter
        counter += 1

    square = lambda x: x * x
    del items[0]
    return OD(), True, False, None, square(counter)
