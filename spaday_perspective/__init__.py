from pathlib import Path

from spaday import ComponentPackage

from .components import PerspectivePanel

__version__ = "0.1.0"

package = ComponentPackage(
    name="perspective",
    assets_dir=Path(__file__).parent / "extension",
    assets=(("js", "cdn/index.js"),),
)

__all__ = ["PerspectivePanel", "package"]
