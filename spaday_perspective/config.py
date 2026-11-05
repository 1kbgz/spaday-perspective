"""Validation of the wrapper's own configuration, and string enums for Perspective settings.

Everything Perspective owns is left to Perspective: a panel's viewer configuration is checked by
the viewer's ``restore`` and a table's ``index``/``limit`` by the engine. A Datagrid ``plugin_config``
is checked in the browser against the plugin's own settings schema when it is applied.
"""

import json
from enum import StrEnum


class EditMode(StrEnum):
    EDIT = "EDIT"
    READ_ONLY = "READ_ONLY"
    SELECT_ROW = "SELECT_ROW"
    SELECT_COLUMN = "SELECT_COLUMN"
    SELECT_REGION = "SELECT_REGION"
    SELECT_ROW_TREE = "SELECT_ROW_TREE"


class Theme(StrEnum):
    LIGHT = "light"
    DARK = "dark"
    PRO_LIGHT = "Pro Light"
    PRO_DARK = "Pro Dark"


class Alignment(StrEnum):
    TOP_LEFT = "top-left"
    TOP = "top"
    TOP_RIGHT = "top-right"
    LEFT = "left"
    CENTER = "center"
    RIGHT = "right"
    BOTTOM_LEFT = "bottom-left"
    BOTTOM = "bottom"
    BOTTOM_RIGHT = "bottom-right"


def _check(value, kind, path):
    valid = {
        "object": lambda: isinstance(value, dict),
        "array": lambda: isinstance(value, list),
        "boolean": lambda: type(value) is bool,
        "string": lambda: isinstance(value, str) and bool(value.strip()),
    }[kind]()
    if not valid:
        raise ValueError(f"{path}: expected {kind}")


def validate_theme(value, path="theme"):
    """Require a nonempty theme name; application-defined names remain supported."""
    _check(value, "string", path)


def _panels(value, path):
    """A mapping of panel configurations the wrapper walks itself."""
    _check(value, "object", path)
    for name, panel in value.items():
        _check(panel, "object", f"{path}.{name}")


def _aliases(value, canonical, legacy, path):
    if canonical in value and legacy in value and value[canonical] != value[legacy]:
        raise ValueError(f"{path}.{canonical}: conflicts with {path}.{legacy}")


def _workspace(value, path):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as error:
            raise ValueError(f"{path}: invalid JSON") from error
    _check(value, "object", path)
    for section in ("panels", "viewers", "retained_panel_configs_by_table", "closed_channels"):
        if value.get(section) is not None:
            _panels(value[section], f"{path}.{section}")
    _aliases(value, "retained_panel_configs_by_table", "closed_channels", path)


def validate_config(config):
    """Validate the wrapper's own settings without changing the input.

    Raises ValueError with the offending path. Panel configurations, table options, plugin
    settings and filter expressions are validated by Perspective when they are applied.
    """
    _check(config, "object", "config")
    for key in ("local", "wait_for_table", "restore_selected_tabs_only", "single_tab"):
        if key in config:
            _check(config[key], "boolean", f"config.{key}")
    for key in ("ws_url", "master_theme"):
        if config.get(key) is not None:
            _check(config[key], "string", f"config.{key}")
    if "default_architecture" in config and config["default_architecture"] not in ("server", "client-server"):
        raise ValueError("config.default_architecture: expected server or client-server")
    if "tables" in config:
        _check(config["tables"], "array", "config.tables")
        for i, table in enumerate(config["tables"]):
            path = f"config.tables[{i}]"
            if isinstance(table, str):
                _check(table, "string", path)
                continue
            _check(table, "object", path)
            _check(table.get("name"), "string", f"{path}.name")
            if "architecture" in table and table["architecture"] not in ("server", "client-server"):
                raise ValueError(f"{path}.architecture: expected server or client-server")
    for key in ("workspace", "layout"):
        if config.get(key) is not None:
            _workspace(config[key], f"config.{key}")
    for key in ("panel_defaults", "channels"):
        if key in config:
            _panels(config[key], f"config.{key}")
    _aliases(config, "workspace", "layout", "config")
    _aliases(config, "panel_defaults", "channels", "config")
    _aliases(config, "restore_selected_tabs_only", "single_tab", "config")
