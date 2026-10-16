"""Indexed row actions. Run with python -m spaday_perspective.row_actions."""

import perspective
from perspective.handlers.starlette import PerspectiveStarletteHandler
from spaday import CallEndpoint, Sequence, SetField, element, event_prop, field, obj
from spaday.backends.starlette import serve
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocketDisconnect

from spaday_perspective import PerspectivePanel, package

server = perspective.Server()
client = server.new_local_client()
records = {
    1: {"id": 1, "order": "First order", "locked": False},
    2: {"id": 2, "order": "Second order", "locked": False},
    3: {"id": 3, "order": "Locked order", "locked": True},
}
table = client.table(list(records.values()), name="orders", index="id")


async def delete_order(request):
    data = await request.json()
    key = data.get("id") if isinstance(data, dict) else None
    if type(key) is not int:
        return JSONResponse({"message": "Expected an integer order ID"}, status_code=422)
    record = records.get(key)
    if record is None:
        return JSONResponse({"message": "Order no longer exists"}, status_code=404)
    # Example record policy; production applications also check the authenticated user's access.
    if record["locked"]:
        return JSONResponse({"message": "Locked orders cannot be deleted"}, status_code=403)
    del records[key]
    table.remove([key])
    return JSONResponse({"message": f"Deleted order {key}"})


async def socket(websocket):
    try:
        await PerspectiveStarletteHandler(perspective_server=server, websocket=websocket).run()
    except WebSocketDisconnect:
        pass


def page():
    return element(
        "main",
        element("h1", "Row actions"),
        element("p", "Click × to request deletion. The server rejects locked orders. Open a second window to see shared updates."),
        PerspectivePanel(
            config={
                "ws_url": "/perspective",
                "tables": ["orders"],
                "layout": {
                    "layout": {"type": "tab-layout", "tabs": ["orders"]},
                    "panels": {"orders": {"table": "orders", "plugin": "Datagrid", "columns": ["id", "order", "locked"]}},
                },
            },
            row_actions={"orders": {"id": {"action": "delete", "label": "Delete order", "text": "×"}}},
        )
        .style(height="320px", width="100%")
        .on(
            "perspective-row-action",
            Sequence(
                CallEndpoint("POST", "/orders/delete", obj({"id": event_prop("detail.key")}), result="reply"),
                SetField("message", field("reply.body.message")),
            ),
        ),
        element("p", role="status").bind("textContent", "message"),
    )


app = serve(
    page,
    packages=[package],
    store={"message": "Ready"},
    routes=[WebSocketRoute("/perspective", socket), Route("/orders/delete", delete_order, methods=["POST"])],
    title="Perspective row actions",
)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8017)
