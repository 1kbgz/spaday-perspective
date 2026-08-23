from pathlib import Path

from spaday import ComponentPackage

from .components import PerspectivePanel

__version__ = "0.4.2"

package = ComponentPackage(
    name="perspective",
    assets_dir=Path(__file__).parent / "extension",
    assets=(("js", "cdn/index.js"),),
    components=(PerspectivePanel,),
)

__all__ = ["PerspectivePanel", "package"]
