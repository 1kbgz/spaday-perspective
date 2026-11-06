import json
import re
import warnings
from copy import deepcopy
from pathlib import Path

import perspective
import pytest

from spaday_perspective import migrate_layout, validate_config

CASES = json.loads((Path(__file__).parent / "fixtures/legacy-layouts.json").read_text())

LINKED = {
    "viewers": {"grid": {"table": "quotes", "linked": True}},
    "detail": {"main": {"type": "tab-area", "widgets": ["grid"], "currentIndex": 0}},
    "mode": "linked",
}


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_legacy_workspace_migration(case):
    source = deepcopy(case["input"])
    with warnings.catch_warnings():
        # a v4 master/detail arrangement is approximated, which perspective-migrate reports
        warnings.simplefilter("ignore")
        result = migrate_layout(source)
        assert source == case["input"]
        assert result["panels"] == source["viewers"]
        assert result["layout"] == case["layout"]
        assert result.get("masters", []) == case["masters"]
        assert result["version"] == perspective.__version__
        assert json.loads(migrate_layout(json.dumps(source))) == result
        # the stamped output is a current layout: migrating it again changes nothing
        assert migrate_layout(result) == result


def test_current_layouts_are_stamped_and_keep_closed_channels():
    layout = {
        "panels": {"a": {"table": "t"}},
        "layout": None,
        "closed_channels": {"t": {"table": "t", "columns": ["x"]}},
    }
    before = deepcopy(layout)
    result = migrate_layout(layout)
    assert layout == before
    assert result == {**layout, "version": perspective.__version__}
    assert result["closed_channels"] is not layout["closed_channels"]


@pytest.mark.parametrize("layout", ["{bad json", "null", '["not a workspace"]', 7, None])
def test_values_that_are_not_mappings_pass_through_unchanged(layout):
    assert migrate_layout(layout) is layout


def test_dropped_information_warns_in_migration_and_fails_validation():
    with pytest.warns(UserWarning, match=r"layout/viewers/grid/linked: dropped by ws\.drop_linked"):
        migrated = migrate_layout(LINKED)
    assert migrated["panels"] == {"grid": {"table": "quotes"}}
    with pytest.raises(ValueError, match=re.escape("config.layout/mode: dropped by ws.drop_linked")):
        validate_config({"layout": LINKED})


def test_unstamped_current_layouts_are_taken_as_written_by_the_installed_release():
    # taken as 2.0.0, a chart's settings would be emptied as pre-d3fc leftovers
    layout = {
        "layout": {"type": "tab-layout", "tabs": ["chart"]},
        "panels": {"chart": {"table": "t", "plugin": "Y Bar", "plugin_config": {"include_zero": True}}},
    }
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        result = migrate_layout(layout)
        validate_config({"layout": layout})
    assert result["panels"] == layout["panels"]


def test_layouts_with_no_current_form_are_rejected():
    # a panel with no table has nothing to bind, whether written as a v4 viewer or in the current shape
    legacy = {"viewers": {"a": {"plugin": "Datagrid"}}, "detail": {"main": {"type": "tab-area", "widgets": ["a"]}}}
    current = {"layout": {"type": "tab-layout", "tabs": ["a"]}, "panels": {"a": {"plugin": "Datagrid"}}}
    with pytest.raises(perspective.PerspectiveError, match="has no `table`"):
        migrate_layout(legacy)
    with pytest.raises(ValueError, match=re.escape("config.layout: viewer.null_table: panel `/panels/a` has no `table`")):
        validate_config({"layout": legacy})
    with pytest.raises(ValueError, match=re.escape("config.layout: migrated config is invalid at `/panels/a`: missing field `table`")):
        validate_config({"layout": current})


def test_validation_warns_about_approximations_and_leaves_the_input_alone():
    config = {
        "layout": {
            "viewers": {"m": {"table": "quotes"}, "d": {"table": "orders"}},
            "master": {"widgets": ["m"]},
            "detail": {"main": {"type": "tab-area", "widgets": ["d"]}},
            "closed_channels": {"orders": {"table": "orders"}},
        }
    }
    before = deepcopy(config)
    with pytest.warns(UserWarning, match=r"config\.layout/layout: the master panels are placed on the left"):
        validate_config(config)
    assert config == before
