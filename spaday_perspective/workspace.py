"""Perspective workspace layout migration, through Perspective's own ``perspective-migrate``."""

import json
import warnings
from copy import deepcopy
from typing import overload

try:
    import perspective
except ImportError:  # the Pyodide example installs this package without the engine
    perspective = None


def describe_notice(notice: dict) -> str:
    """One line for a migration notice, to follow the JSON pointer it concerns."""
    if notice["kind"] == "Dropped":
        return f"dropped by {notice['step']}, no current form for {json.dumps(notice['value'])}"
    return f"{notice['reason']} ({notice['step']})"


def _unstamped(layout: dict) -> bool:
    """Whether a current-shape layout carries no ``version``, so was written by the installed release."""
    return "version" not in layout and not ("viewers" in layout and "panels" not in layout)


# the wrapper's own workspace keys, which ``migrate`` does not know and so would drop
_METADATA = ("retained_panel_configs_by_table", "closed_channels")


def migrate_workspace(layout: dict) -> tuple[dict, list[dict]]:
    """Upgrade a workspace mapping to the installed Perspective's schema."""
    if perspective is None:
        return deepcopy(layout), []
    rest = {key: value for key, value in layout.items() if key not in _METADATA}
    written_by = perspective.__version__ if _unstamped(layout) else None
    result = perspective.migrate("workspace", rest, written_by)
    value = result["value"]
    for key in _METADATA:
        if key in layout:
            value[key] = deepcopy(layout[key])
    return value, result["notices"]


@overload
def migrate_layout(layout: dict) -> dict: ...


@overload
def migrate_layout(layout: str) -> str: ...


def migrate_layout(layout: dict | str) -> dict | str:
    """Upgrade a workspace layout without modifying the input.

    Accepts a mapping or JSON string and returns the same representation, upgraded by
    :func:`migrate_workspace`. What the upgrade dropped or approximated is issued as a warning rather
    than raised. Invalid JSON strings and values that are not mappings pass through unchanged.
    """
    if isinstance(layout, str):
        try:
            parsed = json.loads(layout)
        except ValueError:
            return layout
    else:
        parsed = layout
    if not isinstance(parsed, dict):
        return layout
    value, notices = migrate_workspace(parsed)
    for notice in notices:
        warnings.warn(f"layout{notice['pointer']}: {describe_notice(notice)}", stacklevel=2)
    return json.dumps(value) if isinstance(layout, str) else value
