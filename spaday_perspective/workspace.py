"""Perspective workspace layout migration."""

import json
from copy import deepcopy


def _migrate_node(node: dict) -> dict:
    if node.get("type") == "tab-area":
        return {"type": "tab-layout", "tabs": node.get("widgets") or [], "selected": node.get("currentIndex", 0)}
    children = [_migrate_node(child) for child in node.get("children") or []]
    return {
        "type": "split-layout",
        "orientation": node.get("orientation", "horizontal"),
        "sizes": node.get("sizes") or ([1 / len(children)] * len(children) if children else []),
        "children": children,
    }


def migrate_layout(layout: dict | str) -> dict | str:
    """Convert a v4 workspace envelope to v5 without modifying the input.

    Accepts a mapping or JSON string and returns the same representation. Existing v5 layouts
    and invalid JSON strings pass through unchanged. Panel configurations remain intact.
    """
    if isinstance(layout, str):
        try:
            parsed = json.loads(layout)
        except ValueError:
            return layout
    else:
        parsed = layout
    if not isinstance(parsed, dict) or "viewers" not in parsed or "panels" in parsed:
        return layout
    result = deepcopy(parsed)
    result["panels"] = result.pop("viewers") or {}
    root = (result.pop("detail", None) or {}).get("main")
    master = result.pop("master", None) or {}
    sizes = result.pop("sizes", None)
    if root:
        result["layout"] = _migrate_node(root)
    masters = master.get("widgets") or []
    if masters:
        result["masters"] = masters
        master_layout = {
            "type": "split-layout",
            "orientation": "vertical",
            "sizes": master.get("sizes") or [1 / len(masters)] * len(masters),
            "children": [{"type": "tab-layout", "tabs": [name], "selected": 0} for name in masters],
        }
        result["layout"] = (
            {"type": "split-layout", "orientation": "horizontal", "sizes": sizes or [0.25, 0.75], "children": [master_layout, result["layout"]]}
            if root
            else master_layout
        )
    return json.dumps(result) if isinstance(layout, str) else result
