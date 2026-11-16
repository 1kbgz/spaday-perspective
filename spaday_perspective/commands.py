"""Row commands. Run with python -m spaday_perspective.commands."""

import perspective
from perspective.handlers.starlette import PerspectiveStarletteHandler
from spaday import CallEndpoint, Sequence, SetField, element, event_prop, field, obj
from spaday.backends.starlette import serve
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocketDisconnect

from spaday_perspective import PerspectiveViewer, package

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
    # the command's `hit.id`: the row's index values, one here
    key = data.get("id") if isinstance(data, dict) else None
    key = key[0] if isinstance(key, list) and len(key) == 1 else None
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


# The viewer's command schema is a function, so the page sets it rather than Python. Grouped rows
# and the total row are skipped: their `id` is a group path, not an order.
commands_script = """
<script type="module">
  const commands = [{ kind: "Command", key: "delete", label: "×", title: "Delete order" }];
  const schema = ({ table, hit }) => ({
    commands: table === "orders" && hit?.id?.length && !hit.row_path.length ? commands : [],
  });
  await customElements.whenDefined("perspective-panel");
  let panel;
  while (!(panel = document.querySelector("#orders"))) await new Promise(requestAnimationFrame);
  await panel.setCommandSchema(schema, { scopes: ["datagrid-row"] });
</script>
"""


def page():
    return element(
        "main",
        element("h1", "Row commands"),
        element("p", "Click × to request deletion. The server rejects locked orders. Open a second window to see shared updates."),
        PerspectiveViewer(
            id="orders",
            config={
                "ws_url": "/perspective",
                "tables": ["orders"],
                "workspace": {
                    "layout": {"type": "tab-layout", "tabs": ["orders"]},
                    "panels": {"orders": {"table": "orders", "plugin": "Datagrid", "columns": ["id", "order", "locked"]}},
                },
            },
        )
        .style(height="320px", width="100%")
        .on(
            "perspective-command",
            Sequence(
                CallEndpoint("POST", "/orders/delete", obj({"id": event_prop("detail.context.hit.id")}), result="reply"),
                SetField("message", field("reply.body.message")),
            ),
        ),
        element("p", role="status").bind("textContent", "message"),
    )


app = serve(
    page,
    packages=[package],
    store={"message": "Ready"},
    head=commands_script,
    routes=[WebSocketRoute("/perspective", socket), Route("/orders/delete", delete_order, methods=["POST"])],
    title="Perspective row commands",
)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8017)
