"""Structural checks for the shipped Blockly presets.

    python3 artifacts/deriv-signal-lab/scripts/presets/validate_presets.py \
        artifacts/deriv-signal-lab/src/lib/bot-store/bots/*.xml

Blockly is forgiving in the worst way: a mis-nested element, a duplicated id or
a value outside its wrapper does not raise, it silently loads as something else.
Three shapes have already cost real debugging time in these presets:

  * a `<shadow>` left as a bare child of a block instead of inside its `<value>`,
    which makes the block generate its default (`B = 0`) instead of the value
    that was written there;
  * two elements sharing an id, which makes Blockly bind whichever it saw last
    and silently drop the other;
  * a `field name="VAR"` whose id does not match the declared variable, which
    detaches the get/set block from the variable it looks like it uses.

This script fails on all three, and on duplicate `<next>` stacks.
"""

import sys
import xml.etree.ElementTree as ET

ALLOWED_BLOCK_CHILDREN = {"mutation", "field", "value", "statement", "next", "comment", "data"}


def check(path):
    raw = open(path, encoding="utf-8").read()
    body = raw[raw.index("<xml "):].replace(' xmlns="http://www.w3.org/1999/xhtml"', "", 1)
    root = ET.fromstring(body)

    declared = {variable.text: variable.get("id") for variable in root.find("variables")}
    problems = []
    seen = {}

    for element in root.iter():
        if element.tag in ("block", "shadow"):
            identifier = element.get("id")
            if identifier is None:
                problems.append(("missing id", element.get("type")))
            elif identifier in seen:
                problems.append(("duplicate id", identifier, seen[identifier], element.get("type")))
            else:
                seen[identifier] = element.get("type")
            children = [child.tag for child in element]
            unexpected = [tag for tag in children if tag not in ALLOWED_BLOCK_CHILDREN]
            if unexpected:
                problems.append(("unexpected child", identifier, unexpected))
            if children.count("next") > 1:
                problems.append(("more than one next", identifier))
        if element.tag == "field" and element.get("name") == "VAR":
            name = element.text
            if name not in declared:
                problems.append(("undeclared variable", name, element.get("id")))
            elif element.get("id") != declared[name]:
                problems.append(("variable id mismatch", name, element.get("id"), declared[name]))

    # Two children on one <value> means one of them is dead weight.
    for value in root.iter("value"):
        children = [child for child in value if child.tag in ("block", "shadow")]
        if len(children) > 1:
            problems.append(("value with two blocks", value.get("name"), len(children)))
    return problems


def main(paths):
    failed = False
    for path in paths:
        problems = check(path)
        print(path, "OK" if not problems else f"{len(problems)} problem(s)")
        for problem in problems[:20]:
            print("   ", " ".join(str(part) for part in problem))
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
