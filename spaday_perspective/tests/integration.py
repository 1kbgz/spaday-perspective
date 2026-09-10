"""A downstream component library sharing the page with `<perspective-panel>`.

The integration this exercises end to end:

* the downstream library ships its own element built on Perspective, but imports none of it -- it
  borrows the engine spaday-perspective publishes, so the page holds one copy rather than two that
  cannot coexist;
* it has no Python of its own, binding through spaday's package surface instead: a
  :class:`~spaday.Component` carrying a schema plus a :class:`~spaday.ComponentPackage` that serves
  its bundle, selected with ``packages=[...]`` exactly like a first-party package;
* both elements are authored in one Python tree, the panel streaming a server-held table over
  Perspective's websocket and the downstream grid rendering rows handed to it in the page.

Served for the browser tests; ``/conformance.js`` hands back the check that asserts the downstream
bundle really implements the components its Python side declares.
"""

from pathlib import Path

import perspective
import uvicorn
from perspective.handlers.starlette import PerspectiveStarletteHandler
from spaday import Component, ComponentPackage, ComponentSchema, PropertySchema, check_script, element
from spaday.backends.starlette import serve
from starlette.responses import PlainTextResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from spaday_perspective import PerspectivePanel, package as perspective_package

ROWS = [
    {"symbol": "AAPL", "quantity": 120, "price": 191.2},
    {"symbol": "MSFT", "quantity": 80, "price": 402.5},
    {"symbol": "NVDA", "quantity": 240, "price": 122.9},
]

perspective_server = perspective.Server()
perspective_client = perspective_server.new_local_client()
perspective_client.table(
    {"symbol": "string", "quantity": "integer", "price": "float"},
    name="positions",
    limit=100,
).update(ROWS)


class DemoRowsGrid(Component):
    """The downstream library's element, bound from Python with no Python of its own."""

    tag = "demo-rows-grid"
    schema = ComponentSchema(
        tag="demo-rows-grid",
        class_name="DemoRowsGrid",
        summary="A downstream grid over rows held in the page.",
        props=(PropertySchema(name="rows", kind="json", description="Rows to render."),),
        events=("demo-grid-ready",),
    )


downstream_package = ComponentPackage(
    name="demo-downstream",
    assets_dir=Path(__file__).parent / "downstream",
    assets=(("js", "downstream.js"),),
    components=(DemoRowsGrid,),
)

PACKAGES = [perspective_package, downstream_package]

page = element("div", id="app").child(
    element("h1").text("Two libraries, one Perspective engine"),
    element("section", id="server-backed").child(
        PerspectivePanel(
            id="panel",
            config={
                "ws_url": "/perspective",
                "tables": ["positions"],
                "layout": {
                    "layout": {"type": "tab-layout", "tabs": ["positions"]},
                    "panels": {"positions": {"table": "positions", "plugin": "Datagrid"}},
                },
            },
        ).style(display="block", width="640px", height="240px"),
    ),
    element("section", id="in-page").child(
        DemoRowsGrid(id="grid", rows=ROWS).style(display="block", width="640px", height="240px"),
    ),
)


async def perspective_socket(websocket: WebSocket) -> None:
    try:
        await PerspectiveStarletteHandler(perspective_server=perspective_server, websocket=websocket).run()
    except WebSocketDisconnect:
        pass


async def conformance(request) -> PlainTextResponse:
    """The browser-side check for the downstream bundle, built from the schemas its package carries."""
    return PlainTextResponse(check_script([downstream_package]), media_type="text/plain")


app = serve(
    page,
    packages=PACKAGES,
    routes=[
        WebSocketRoute("/perspective", perspective_socket),
        Route("/conformance.js", conformance),
    ],
    title="spaday-perspective downstream integration",
)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8016)
