import ast
from pathlib import Path

from spaday import generate
from spaday.bootstrap import bootstrap

from spaday_perspective import PerspectivePanel, package


def test_perspective_panel_serializes_config_and_theme():
    node = PerspectivePanel(config={"ws_url": "/perspective", "layout": {"viewers": {}}}, theme="dark").to_node()
    assert node["tag"] == "perspective-panel"
    assert node["props"]["config"]["Map"]["ws_url"] == {"Str": "/perspective"}
    assert node["props"]["theme"] == {"Str": "dark"}


def test_package_drives_bootstrap_asset_url():
    assert package.name == "perspective"
    assert 'src="/components/perspective/cdn/index.js"' in bootstrap(packages=[package])


def test_generated_component_is_current():
    root = Path(__file__).parent.parent
    fresh = generate(str(root / "components.cem.json"))
    assert ast.dump(ast.parse(fresh)) == ast.dump(ast.parse((root / "components.py").read_text(encoding="utf-8")))
