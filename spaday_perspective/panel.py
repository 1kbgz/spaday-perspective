"""Validated authoring surface over the generated component binding."""

from .action_config import validate_row_actions
from .components import PerspectivePanel as GeneratedPanel
from .config import validate_config, validate_theme


class PerspectivePanel(GeneratedPanel):
    """Perspective panel with validation of literal configuration at serialization."""

    def to_node(self) -> dict:
        validate_row_actions(self._props.get("rowActions"))
        if self._props.get("config") is not None:
            validate_config(self._props["config"])
        if self._props.get("theme") is not None:
            validate_theme(self._props["theme"])
        if self._props.get("themes") is not None:
            if not isinstance(self._props["themes"], list):
                raise ValueError("themes: expected array")
            for index, theme in enumerate(self._props["themes"]):
                validate_theme(theme, f"themes[{index}]")
        return super().to_node()
