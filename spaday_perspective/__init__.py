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
#: Deliberately empty. Perspective owns its own theming: the viewer ships named CSS themes
#: (``"Pro Light"`` / ``"Pro Dark"``, plus any an application registers) and the panel selects one
#: through its ``theme`` property, which is what spaday's page-mode binding drives::
#:
#:     PerspectivePanel(...).compute("theme", cond(field("dark"), "dark", "light"))
#:
#: Wrapping those in ``--spa-perspective-*`` tokens would only be able to express a fraction of
#: what a Perspective theme controls, so this package does not pretend otherwise. An application
#: with its own branding registers a Perspective theme and names it here.
TOKENS: dict[str, tuple[str, str]] = {}

__all__ = ["TOKENS", "PerspectivePanel", "package"]
