import json
from pathlib import Path

from spaday import ComponentPackage

from .action_config import validate_row_actions
from .config import Alignment, EditMode, Theme, validate_config
from .panel import PerspectivePanel
from .workspace import migrate_layout

__version__ = "0.8.1"

# the exact version of each JS library the package serves, written by its JS build
_VERSIONS = Path(__file__).parent / "extension" / "versions.json"

package = ComponentPackage(
    name="perspective",
    assets_dir=Path(__file__).parent / "extension",
    assets=(("js", "cdn/index.js"),),
    components=(PerspectivePanel,),
    # Perspective's modules under its own bare specifiers: a library on the page that imports
    # Perspective resolves to this copy instead of registering the same elements a second time
    imports=(
        ("@perspective-dev/client", "vendor/@perspective-dev/client/dist/cdn/perspective.js"),
        ("@perspective-dev/viewer", "vendor/@perspective-dev/viewer/dist/cdn/perspective-viewer.js"),
        ("@perspective-dev/viewer-charts", "vendor/@perspective-dev/viewer-charts/dist/cdn/perspective-viewer-charts.js"),
        ("@perspective-dev/viewer-datagrid", "vendor/@perspective-dev/viewer-datagrid/dist/cdn/perspective-viewer-datagrid.js"),
    ),
    provides=json.loads(_VERSIONS.read_text(encoding="utf-8")) if _VERSIONS.exists() else {},
)

#: ``css()`` kwarg → (CSS custom property, what it controls), in the shape of
#: :data:`spaday.theme.SHELL_TOKENS`.
#:
#: These style the wrapper's optional row buttons. The underlying grid uses named :data:`THEMES`.
TOKENS: dict[str, tuple[str, str]] = {
    "spa_perspective_action_color": ("--spa-perspective-action-color", "Row action button text"),
    "spa_perspective_action_background": ("--spa-perspective-action-background", "Row action button background"),
    "spa_perspective_action_border": ("--spa-perspective-action-border", "Row action button border"),
}

#: Page mode → the Perspective theme ``<perspective-panel>`` applies for it: Perspective's answer to
#: :data:`TOKENS`. A panel with no ``theme`` follows the nearest ``wa-dark`` / ``wa-light`` ancestor
#: to one of these. ``theme`` and ``themes`` accept the keys as shorthands and pass any other name to
#: Perspective unchanged, which is how an application selects a theme of its own once the page
#: carries its CSS::
#:
#:     PerspectivePanel(...).compute("theme", cond(field("dark"), "Acme Dark", "Acme Light"))
THEMES = {"light": "Pro Light", "dark": "Pro Dark"}

__all__ = [
    "THEMES",
    "TOKENS",
    "Alignment",
    "EditMode",
    "PerspectivePanel",
    "Theme",
    "migrate_layout",
    "package",
    "validate_config",
    "validate_row_actions",
]
