from pathlib import Path

from spaday import ComponentPackage

from .components import PerspectivePanel

__version__ = "0.6.0"

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
)

#: ``css()`` kwarg → (CSS custom property, what it controls), in the shape of
#: :data:`spaday.theme.SHELL_TOKENS`.
#:
#: Deliberately empty. Perspective themes itself by name rather than by custom property, so what an
#: application overrides is a theme name, not a token -- see :data:`THEMES`. Wrapping Perspective's
#: themes in ``--spa-perspective-*`` tokens would only be able to express a fraction of what one
#: controls, so this package does not pretend otherwise.
TOKENS: dict[str, tuple[str, str]] = {}

#: Page mode → the Perspective theme ``<perspective-panel>`` applies for it: Perspective's answer to
#: :data:`TOKENS`. A panel with no ``theme`` follows the nearest ``wa-dark`` / ``wa-light`` ancestor
#: to one of these. ``theme`` and ``themes`` accept the keys as shorthands and pass any other name to
#: Perspective unchanged, which is how an application selects a theme of its own once the page
#: carries its CSS::
#:
#:     PerspectivePanel(...).compute("theme", cond(field("dark"), "Acme Dark", "Acme Light"))
THEMES = {"light": "Pro Light", "dark": "Pro Dark"}

__all__ = ["THEMES", "TOKENS", "PerspectivePanel", "package"]
