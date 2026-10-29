import copy

import pytest
from spaday import field, obj

from spaday_perspective import PerspectivePanel, validate_row_actions


@pytest.mark.parametrize(
    "policy",
    [
        None,
        {},
        {"rows": {"id": []}},
        {"rows": {"id": {"action": "copy", "label": "Copy", "icon": "copy"}}},
        {
            "rows": {
                "@actions": {
                    "header": "Actions",
                    "position": "end",
                    "buttons": [
                        {"action": "copy", "label": "Copy", "icon": "copy"},
                        {"action": "delete", "label": "Delete", "icon": "delete", "text": "Remove"},
                    ],
                }
            }
        },
    ],
)
def test_valid_actions_serialize_without_mutating_input(policy):
    original = copy.deepcopy(policy)
    validate_row_actions(policy)
    PerspectivePanel(row_actions=policy).to_node()
    assert policy == original


@pytest.mark.parametrize(
    "policy",
    [
        [],
        {1: {}},
        {"rows": {1: []}},
        {"rows": []},
        {"rows": {"id": None}},
        {"rows": {"id": {"action": "copy", "label": "Copy", "icon": "unknown"}}},
        {"rows": {"id": {"action": "copy", "label": "Copy", "text": None}}},
        {"rows": {"@actions": {"header": 5, "position": "start", "buttons": []}}},
        {"rows": {"actions": {"header": "Actions", "position": "start", "buttons": []}}},
        {"rows": {"@actions": {"header": " ", "position": "start", "buttons": []}}},
        {"rows": {"@actions": {"header": "Actions", "position": "middle", "buttons": []}}},
        {"rows": {"@actions": {"header": "Actions", "position": "start", "buttons": {}}}},
        {
            "rows": {
                "@one": {"header": "Actions", "position": "start", "buttons": []},
                "@two": {"header": "Actions", "position": "end", "buttons": []},
            }
        },
    ],
)
def test_invalid_actions_fail_at_serialization_including_prop_updates(policy):
    with pytest.raises(ValueError, match="row_actions"):
        PerspectivePanel(row_actions=policy).to_node()
    with pytest.raises(ValueError, match="row_actions"):
        PerspectivePanel().prop("rowActions", policy).to_node()


def test_computed_actions_remain_browser_validated():
    PerspectivePanel().compute("rowActions", obj({"rows": field("policy")})).to_node()
