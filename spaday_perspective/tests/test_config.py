import json
import re
from copy import deepcopy
from pathlib import Path

import pytest

from spaday_perspective import THEMES, Alignment, EditMode, PerspectivePanel, Theme, validate_config

CASES = json.loads((Path(__file__).parent / "fixtures" / "config-validation.json").read_text())


@pytest.mark.parametrize("config", CASES["valid"])
def test_valid_config_is_not_modified(config):
    before = deepcopy(config)
    validate_config(config)
    PerspectivePanel(config=config).to_node()
    assert config == before


@pytest.mark.parametrize("config,path", CASES["invalid"])
def test_invalid_config_reports_its_path(config, path):
    with pytest.raises(ValueError, match=re.escape(path)):
        PerspectivePanel(config=config).to_node()


def test_perspective_owned_settings_pass_through():
    # the viewer and the plugin check these when they are applied, not Python
    for config in (
        {"tables": [{"name": "t", "index": [], "limit": -1}]},
        {"channels": {"t": {"plugin": "Nope", "theme": " ", "plugin_config": {"edit_mode": "wrong", "scroll_mode": True}}}},
        {"layout": {"panels": {"grid": {"table": "t", "columns": ["absent"], "filter": [["absent", "==", 1]]}}}},
    ):
        validate_config(config)
    PerspectivePanel(theme=" ", themes=["", "dark"]).to_node()


def test_enums_serialize_as_strings():
    assert set(Theme) == {*THEMES, *THEMES.values()}
    panel = PerspectivePanel(
        theme=Theme.DARK, config={"channels": {"t": {"plugin_config": {"edit_mode": EditMode.SELECT_REGION, "align": Alignment.CENTER}}}}
    )
    node = panel.to_node()
    assert node["props"]["theme"] == {"Str": "dark"}
    assert "SELECT_REGION" in json.dumps(node)
    assert '"center"' in json.dumps(node)


def test_custom_themes_and_fluent_prop_updates():
    panel = PerspectivePanel(theme="Company Dark", themes=["Company Dark"])
    panel.to_node()
    panel.prop("config", {"channels": {"t": "trades"}})
    with pytest.raises(ValueError, match="config.channels.t"):
        panel.to_node()
