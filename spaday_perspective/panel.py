"""Validated authoring surface over the generated component binding."""

from .components import PerspectivePanel as GeneratedPanel
from .config import validate_config


class PerspectivePanel(GeneratedPanel):
    """Perspective workspace with validation of literal configuration at serialization."""

    def to_node(self) -> dict:
        if self._props.get("config") is not None:
            validate_config(self._props["config"])
        if self._props.get("themes") is not None and not isinstance(self._props["themes"], list):
            raise ValueError("themes: expected array")
        return super().to_node()
