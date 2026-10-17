import json
import re
from copy import deepcopy
from pathlib import Path

import pytest

from spaday_perspective import THEMES, Alignment, EditMode, PerspectivePanel, Theme, validate_config
from spaday_perspective.config import DATAGRID_CONFIG

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


def test_enums_match_the_shared_contract_and_serialize_as_strings():
    assert set(EditMode) == set(DATAGRID_CONFIG["edit_mode"]["values"])
    assert set(Alignment) == set(DATAGRID_CONFIG["align"]["values"])
    assert set(Theme) == {*THEMES, *THEMES.values()}
    panel = PerspectivePanel(theme=Theme.DARK, config={"channels": {"t": {"plugin_config": {"edit_mode": EditMode.SELECT_REGION}}}})
    node = panel.to_node()
    assert node["props"]["theme"] == {"Str": "dark"}
    assert "SELECT_REGION" in json.dumps(node)


@pytest.mark.parametrize("props", [{"theme": " "}, {"themes": "dark"}, {"themes": ["dark", ""]}])
def test_invalid_theme_names(props):
    with pytest.raises(ValueError, match="theme"):
        PerspectivePanel(**props).to_node()


def test_custom_themes_and_fluent_prop_updates():
    panel = PerspectivePanel(theme="Company Dark", themes=["Company Dark"])
    panel.to_node()
    panel.prop("config", {"channels": {"t": {"plugin_config": {"edit_mode": "wrong"}}}})
    with pytest.raises(ValueError, match="edit_mode"):
        panel.to_node()
