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
