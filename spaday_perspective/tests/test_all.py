import ast
import json
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
    assert [(schema.tag, schema.class_name) for schema in package.catalog] == [("perspective-panel", "PerspectivePanel")]
    assert 'src="/components/perspective/cdn/index.js"' in bootstrap(packages=[package])


def test_generated_component_is_current():
    root = Path(__file__).parent.parent
    fresh = generate(str(root / "components.cem.json"))
    assert ast.dump(ast.parse(fresh)) == ast.dump(ast.parse((root / "components.py").read_text(encoding="utf-8")))


def test_perspective_python_pin_matches_the_bundled_js_client():
    # the frontend bundle inlines @perspective-dev/* at an exact version, and Perspective's
    # websocket wire protocol is version-locked but stable within a minor — the Python server
    # requirement must track the bundled client's minor
    root = Path(__file__).parent.parent.parent
    js_version = json.loads((root / "js" / "package.json").read_text(encoding="utf-8"))["dependencies"]["@perspective-dev/client"]
    major, minor = js_version.split(".")[:2]
    expected = f'"perspective-python>={major}.{minor},<{major}.{int(minor) + 1}"'
    assert expected in (root / "pyproject.toml").read_text(encoding="utf-8")
    # every bundled @perspective-dev package moves in lockstep with the client
    deps = json.loads((root / "js" / "package.json").read_text(encoding="utf-8"))["dependencies"]
    assert all(v == js_version for k, v in deps.items() if k.startswith("@perspective-dev/"))


def test_panel_serializes_viewer_options_and_declares_events():
    node = PerspectivePanel(settings=True, autosize=False, throttle=500, themes=["light", "dark"]).to_node()
    assert node["props"]["settings"] == {"Bool": True}
    assert node["props"]["autosize"] == {"Bool": False}
    assert node["props"]["throttle"] == {"Int": 500}
    assert node["props"]["themes"]["List"] == [{"Str": "light"}, {"Str": "dark"}]
    assert "perspective-config-update" in PerspectivePanel.schema.events
