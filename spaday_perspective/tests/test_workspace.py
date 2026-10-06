import json
from copy import deepcopy
from pathlib import Path

import pytest

from spaday_perspective import migrate_layout

CASES = json.loads((Path(__file__).parent / "fixtures/legacy-layouts.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_legacy_workspace_migration(case):
    source = deepcopy(case["input"])
    result = migrate_layout(source)
    assert source == case["input"]
    assert result["panels"] == source["viewers"]
    assert result["layout"] == case["layout"]
    assert result.get("masters", []) == case["masters"]
    assert json.loads(migrate_layout(json.dumps(source))) == result
    assert migrate_layout(result) is result


@pytest.mark.parametrize("layout", [{"panels": {}, "layout": None}, "{bad json", "null", '["not a workspace"]', '{"panels":{}}'])
def test_other_layouts_pass_through_unchanged(layout):
    assert migrate_layout(layout) is layout
