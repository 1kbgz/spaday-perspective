"""Validation for the pinned Perspective Datagrid and wrapper configuration."""

import json
import math
from enum import StrEnum
from pathlib import Path


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


DATAGRID_CONFIG = json.loads(Path(__file__).with_name("config-contract.json").read_text(encoding="utf-8"))


def _check(value, kind, path):
    valid = {
        "object": lambda: isinstance(value, dict),
        "array": lambda: isinstance(value, list),
        "boolean": lambda: type(value) is bool,
        "string": lambda: isinstance(value, str) and bool(value.strip()),
        "number": lambda: type(value) in (int, float) and math.isfinite(value),
    }[kind]()
    if not valid:
        raise ValueError(f"{path}: expected {kind}")


def validate_theme(value, path="theme"):
    """Require a nonempty theme name; application-defined names remain supported."""
    _check(value, "string", path)


def _panel(panel, path):
    _check(panel, "object", path)
    for key in ("table", "plugin", "theme"):
        if key in panel and panel[key] is not None:
            _check(panel[key], "string", f"{path}.{key}")
    if "plugin_config" not in panel or panel["plugin_config"] is None:
        return
    plugin = panel["plugin_config"]
    if panel.get("plugin") not in (None, "Datagrid"):
        return
    _check(plugin, "object", f"{path}.plugin_config")
    rules = {**DATAGRID_CONFIG, "editable": {"kind": "boolean"}, "columns": {"kind": "object"}}
    for key, value in plugin.items():
        target = f"{path}.plugin_config.{key}"
        if key not in rules:
            raise ValueError(f"{target}: unknown Datagrid setting")
        rule = rules[key]
        if rule["kind"] == "enum":
            if value not in rule["values"]:
                raise ValueError(f"{target}: expected one of {', '.join(rule['values'])}")
        else:
            _check(value, rule["kind"], target)
        if rule["kind"] == "number" and (value < 0 if key == "zebra_rows" else value <= 0):
            raise ValueError(f"{target}: expected {'nonnegative' if key == 'zebra_rows' else 'positive'} number")


def _workspace(value, path):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as error:
            raise ValueError(f"{path}: invalid JSON") from error
    _check(value, "object", path)
    for section in ("panels", "viewers", "closed_channels"):
        if section in value and value[section] is not None:
            _check(value[section], "object", f"{path}.{section}")
            for name, panel in value[section].items():
                _panel(panel, f"{path}.{section}.{name}")


def validate_config(config):
    """Validate known wrapper and Datagrid settings without changing the input.

    Raises ValueError with the offending path. Custom plugins and per-column style payloads
    remain upstream-owned; table-dependent filter expressions are validated by Perspective.
    """
    _check(config, "object", "config")
    for key in ("local", "wait_for_table", "single_tab"):
        if key in config:
            _check(config[key], "boolean", f"config.{key}")
    for key in ("ws_url", "master_theme"):
        if key in config and config[key] is not None:
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
            if "index" in table:
                _check(table["index"], "string", f"{path}.index")
            if "limit" in table and (type(table["limit"]) is not int or table["limit"] <= 0):
                raise ValueError(f"{path}.limit: expected positive integer")
            if "index" in table and "limit" in table:
                raise ValueError(f"{path}: index and limit are mutually exclusive")
    if config.get("layout") is not None:
        _workspace(config["layout"], "config.layout")
    if "channels" in config:
        _check(config["channels"], "object", "config.channels")
        for name, panel in config["channels"].items():
            _panel(panel, f"config.channels.{name}")
