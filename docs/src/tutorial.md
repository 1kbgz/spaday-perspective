# Build a live market workspace

In this tutorial, you will serve a named Perspective table and display it in a spaday component tree.

## Install the packages

```bash
pip install "spaday[examples]" spaday-perspective "perspective-python>=4.5,<4.6"
```

## Create the server and table

Save this as `market_app.py`:

```python
import perspective
import uvicorn
from perspective.handlers.starlette import PerspectiveStarletteHandler
from spaday.backends.starlette import serve
from spaday_perspective import PerspectivePanel
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket

server = perspective.Server()
client = server.new_local_client()
client.table(
    [
        {"symbol": "AAPL", "quantity": 100, "price": 211.10},
        {"symbol": "MSFT", "quantity": 75, "price": 503.02},
    ],
    name="trades",
)


async def perspective_socket(websocket: WebSocket) -> None:
    await PerspectiveStarletteHandler(
        perspective_server=server,
        websocket=websocket,
    ).run()
```

Perspective owns this websocket and the bulk table data carried by it.

## Add the panel

Continue in the same file:

```python
layout = {
    "sizes": [1],
    "detail": {
        "main": {
            "type": "tab-area",
            "widgets": ["market"],
            "currentIndex": 0,
        }
    },
    "master": {"sizes": [], "widgets": []},
    "mode": "globalFilters",
    "viewers": {
        "market": {
            "table": "trades",
            "plugin": "Datagrid",
            "columns": ["symbol", "quantity", "price"],
        }
    },
}

panel = PerspectivePanel(
    config={
        "ws_url": "/perspective",
        "tables": ["trades"],
        "layout": layout,
    },
    theme="light",
    style="height: 32rem",
)

app = serve(
    panel,
    packages=["perspective"],
    routes=[WebSocketRoute("/perspective", perspective_socket)],
)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
```

Run `python market_app.py`, then open `http://127.0.0.1:8000`. You should see both rows in a Perspective
datagrid.

You now have a live data channel and a serializable workspace configuration. Continue with
[Stream data and change layouts](how-to.md), or run the polished [complete market example](../../spaday_perspective/example.py).
