"""Validate literal row-action policies before sending them to the browser."""

from .config import _check


def validate_row_actions(value):
    """Validate legacy indexed actions and dedicated columns without changing input."""
    if value is None:
        return
    _check(value, "object", "row_actions")
    if any(not isinstance(table, str) for table in value):
        raise ValueError("row_actions: expected string table names")
    for table, columns in value.items():
        _check(columns, "object", f"row_actions.{table}")
        if any(not isinstance(key, str) for key in columns):
            raise ValueError(f"row_actions.{table}: expected string column identifiers")
        headers = set()
        for key, entry in columns.items():
            path = f"row_actions.{table}.{key}"
            if isinstance(entry, dict) and "buttons" in entry:
                header = entry.get("header")
                if (
                    not key.startswith("@")
                    or not isinstance(header, str)
                    or not header.strip()
                    or header in headers
                    or entry.get("position") not in ("start", "end")
                    or not isinstance(entry["buttons"], list)
                ):
                    raise ValueError(f"{path}: action columns require an @ identifier, unique nonempty header, start/end position, and buttons array")
                headers.add(header)
                rules = entry["buttons"]
            else:
                rules = entry if isinstance(entry, list) else [entry]
            for rule in rules:
                if (
                    not isinstance(rule, dict)
                    or any(not isinstance(rule.get(name), str) or not rule[name] for name in ("action", "label"))
                    or ("text" in rule and not isinstance(rule["text"], str))
                    or ("icon" in rule and rule["icon"] not in ("copy", "delete", "add"))
                ):
                    raise ValueError(f"{path}: expected action and label strings, optional text, and an optional copy/delete/add icon")
