import asyncio
import logging
import sys
from datetime import UTC, datetime

import transports
from pydantic import BaseModel
from spaday import CallEndpoint, If, Invoke, Sequence, SetField, ToggleField, by_id, cond, element, eq, event_prop, field, obj
from spaday.backends.starlette import serve
from starlette.responses import JSONResponse
from starlette.routing import Route

IS_PYODIDE = sys.platform == "emscripten"

if not IS_PYODIDE:
    import perspective
    from perspective.handlers.starlette import PerspectiveStarletteHandler
    from starlette.routing import WebSocketRoute
    from starlette.websockets import WebSocket, WebSocketDisconnect

from spaday_perspective import EditMode, PerspectivePanel, package

logger = logging.getLogger("uvicorn.error")


class MarketFeed(BaseModel):
    row_count: str = "0"
    last_trade: str = "$0.00"
    notional: str = "$0"
    stream_status: str = "Connecting"


feed = MarketFeed()
session = transports.Session()
session.host(feed)
transport_server = transports.Server(session)

if IS_PYODIDE:
    perspective_server = None
    trades = None
else:
    perspective_server = perspective.Server()
    perspective_client = perspective_server.new_local_client()
    trades = perspective_client.table(
        {
            "id": "integer",
            "time": "string",
            "symbol": "string",
            "side": "string",
            "quantity": "integer",
            "price": "float",
            "venue": "string",
        },
        index="id",
        name="trades",
    )

symbols = ("AAPL", "MSFT", "NVDA", "AMZN", "META")
venues = ("XNAS", "XNYS", "ARCX", "BATS")
row_count = 0
browser_updates: list[dict] = []
browser_removals: list[int] = []
records: dict[int, dict] = {}
initial_trades: list[dict] = []


def append_trade(*, symbol: str, side: str, quantity: int, price: float, publish: bool = True) -> dict:
    global row_count
    row_count += 1
    trade = {
        "id": row_count,
        "time": datetime.now(UTC).strftime("%H:%M:%S"),
        "symbol": symbol,
        "side": side,
        "quantity": quantity,
        "price": round(price, 2),
        "venue": venues[row_count % len(venues)],
    }
    records[row_count] = trade
    if len(records) > 1_000:
        oldest = next(iter(records))
        remove_trade(oldest)
    if trades is not None:
        trades.update([trade])
    elif publish:
        browser_updates.append(trade)
    refresh_metrics()
    feed.stream_status = "Live"
    return trade


def refresh_metrics() -> None:
    feed.row_count = f"{len(records):,}"
    latest = next(reversed(records.values()), None)
    feed.last_trade = f"${latest['price']:,.2f}" if latest else "$0.00"
    feed.notional = f"${sum(trade['quantity'] * trade['price'] for trade in records.values()):,.0f}"


def remove_trade(key: int) -> None:
    if trades is not None:
        trades.remove([key])
    else:
        browser_removals.append(key)
    del records[key]
    refresh_metrics()


for index in range(80):
    initial_trades.append(
        append_trade(
            symbol=symbols[index % len(symbols)],
            side="Buy" if index % 3 else "Sell",
            quantity=25 + (index * 17) % 450,
            price=round(118 + index * 0.73 + (index % 7) * 1.21, 2),
            publish=False,
        )
    )


async def stream_trades() -> None:
    tick = 0
    while True:
        await asyncio.sleep(1.5)
        tick += 1
        append_trade(
            symbol=symbols[tick % len(symbols)],
            side="Buy" if tick % 2 else "Sell",
            quantity=50 + (tick * 31) % 500,
            price=round(175 + tick * 0.19 + (tick % 9) * 0.87, 2),
        )


async def submit_trade(request):
    payload = await request.json()
    symbol = str(payload.get("symbol", "AAPL")).upper()
    side = str(payload.get("side", "Buy")).title()
    quantity = max(1, int(payload.get("quantity", 100)))
    price = 185 + row_count % 23 * 0.61
    trade = append_trade(symbol=symbol, side=side, quantity=quantity, price=price)
    logger.info("Trade received from browser: %s", trade)
    return JSONResponse({"message": f"Added {quantity} {symbol} shares at ${price:,.2f}"})


async def delete_trade(request):
    payload = await request.json()
    key = payload.get("id") if isinstance(payload, dict) else None
    if type(key) is not int:
        return JSONResponse({"message": "Expected an integer trade ID"}, status_code=422)
    if key not in records:
        return JSONResponse({"message": "Trade no longer exists"}, status_code=404)
    # Demo data only. Production endpoints must check the authenticated user's access.
    remove_trade(key)
    return JSONResponse({"message": f"Deleted trade {key}"})


async def copy_trade(request):
    payload = await request.json()
    key = payload.get("id") if isinstance(payload, dict) else None
    if type(key) is not int:
        return JSONResponse({"message": "Expected an integer trade ID"}, status_code=422)
    if key not in records:
        return JSONResponse({"message": "Trade no longer exists"}, status_code=404)
    # Demo data only. Production endpoints must check the authenticated user's access.
    trade = records[key]
    return JSONResponse({"message": f"Copied trade {key} to form", **{name: trade[name] for name in ("symbol", "side", "quantity")}})


if not IS_PYODIDE:

    async def perspective_socket(websocket: WebSocket) -> None:
        try:
            await PerspectiveStarletteHandler(perspective_server=perspective_server, websocket=websocket).run()
        except WebSocketDisconnect:
            pass


def layout(*, grouped: bool = False) -> dict:
    viewer = {
        "table": "trades",
        "plugin": "Datagrid",
        "title": "Live market activity",
        "columns": ["id", "time", "symbol", "side", "quantity", "price", "venue"],
        "sort": [["id", "desc"]],
        "plugin_config": {"edit_mode": EditMode.SELECT_REGION, "scroll_lock": True},
    }
    if grouped:
        viewer.update(
            {
                "title": "Liquidity by symbol",
                "group_by": ["symbol", "side"],
                "columns": ["quantity", "price"],
                "aggregates": {"quantity": "sum", "price": "avg"},
                "sort": [["quantity", "desc"]],
            }
        )
    # Perspective 5's whole-element config: a regular-layout tree plus per-panel viewer configs
    return {
        "layout": {"type": "tab-layout", "tabs": ["market"]},
        "panels": {"market": viewer},
    }


panel = (
    PerspectivePanel(
        id="market-grid",
        toolbar=True,
        hide_tabs=True,
        find=True,
        row_actions={
            "trades": {
                "@copy": {
                    "header": "Copy",
                    "position": "start",
                    "buttons": [{"action": "copy", "label": "Copy trade to form", "icon": "copy"}],
                },
                "@delete": {
                    "header": "Delete",
                    "position": "end",
                    "buttons": [{"action": "delete", "label": "Delete trade", "icon": "delete"}],
                },
            }
        },
    )
    .on(
        "perspective-row-action",
        If(
            eq(event_prop("detail.action"), "delete"),
            Sequence(
                SetField("delete_trade_id", event_prop("detail.key")),
                Invoke(by_id("delete-trade-dialog"), "showModal"),
            ),
            If(
                eq(event_prop("detail.action"), "copy"),
                Sequence(
                    CallEndpoint("POST", "/api/trades/copy", obj({"id": event_prop("detail.key")}), result="copy_result"),
                    SetField("trade_result", field("copy_result")),
                    If(
                        field("copy_result.ok"),
                        Sequence(*(SetField(name, field(f"copy_result.body.{name}")) for name in ("symbol", "side", "quantity"))),
                    ),
                ),
            ),
        ),
    )
    .compute("theme", cond(field("dark"), "dark", "light"))
    .compute(
        "config",
        obj(
            {
                **({"local": True} if IS_PYODIDE else {"ws_url": "/perspective"}),
                "tables": ["trades"],
                "channels": {"trades": layout()["panels"]["market"]},
                "layout": cond(eq(field("view"), "grouped"), layout(grouped=True), layout()),
            }
        ),
    )
)

page = element(
    "main",
    element(
        "header",
        element(
            "div",
            element("p", class_="eyebrow").text("LIVE ANALYTICS WORKSPACE"),
            element("h1").text("Perspective market monitor"),
            element("p", class_="lede").text("Native columnar analytics with interactive orders and reactive controls."),
        ),
        element("button", class_="theme-button").text("Toggle theme").on("click", ToggleField("dark")),
        class_="page-header",
    ),
    element(
        "section",
        element("article", element("span").text("Current trades"), element("strong").bind("textContent", "row_count")),
        element("article", element("span").text("Last trade"), element("strong").bind("textContent", "last_trade")),
        element("article", element("span").text("Total notional"), element("strong").bind("textContent", "notional")),
        element(
            "article",
            element("span", class_="live-dot"),
            element("strong").bind("textContent", "stream_status"),
            class_="live-metric",
        ),
        class_="metrics",
    ),
    element(
        "section",
        element(
            "div",
            element("h2").text("Trades workspace"),
            element("p").text(
                "Rows and analytics stay in this browser's Perspective worker."
                if IS_PYODIDE
                else "Rows stream over Perspective's websocket; only summary state uses transports."
            ),
            element("p").text(
                "Click × to delete a trade or ⧉ to copy it to the form. Totals cover all retained trades, including filtered-out rows."
            ),
            element("p").text("Select cells to copy with Ctrl+C / Cmd+C. Use Find or Ctrl+F / Cmd+F in the grid to filter a column."),
        ),
        element(
            "div",
            element("button").text("Live blotter").on("click", SetField("view", "blotter")),
            element("button").text("Group by symbol").on("click", SetField("view", "grouped")),
            class_="segmented",
        ),
        class_="workspace-heading",
    ),
    element("section", panel, class_="workspace-shell"),
    element(
        "dialog",
        element("h2").text("Delete trade?"),
        element("p", "Delete trade ", element("strong").bind("textContent", "delete_trade_id"), " and update the totals?"),
        element(
            "div",
            element("button", type="button", autofocus=True).text("Cancel").on("click", Invoke(by_id("delete-trade-dialog"), "close")),
            element("button", type="button")
            .text("Delete trade")
            .on(
                "click",
                Sequence(
                    Invoke(by_id("delete-trade-dialog"), "close"),
                    CallEndpoint("POST", "/api/trades/delete", obj({"id": field("delete_trade_id")}), result="trade_result"),
                ),
            ),
            class_="dialog-actions",
        ),
        id="delete-trade-dialog",
        class_="delete-dialog",
        **{"aria-label": "Delete trade?"},
    ),
    element(
        "section",
        element(
            "div",
            element("label", "Symbol", element("input", value="AAPL").bind("value", "symbol", mode="two-way")),
            element(
                "label",
                "Side",
                element(
                    "select",
                    element("option", "Buy", value="Buy"),
                    element("option", "Sell", value="Sell"),
                ).bind("value", "side", mode="two-way"),
            ),
            element(
                "label",
                "Quantity",
                element("input", type="number", min=1, step=1, value=100).bind("value", "quantity", mode="two-way"),
            ),
            class_="order-fields",
        ),
        element(
            "button",
            class_="submit-button",
        )
        .text("Add trade")
        .on(
            "click",
            CallEndpoint(
                "POST",
                "/api/trades",
                obj({"symbol": field("symbol"), "side": field("side"), "quantity": field("quantity")}),
                result="trade_result",
            ),
        ),
        element("p", class_="order-status").bind("textContent", "trade_result.body.message"),
        class_="order-card",
    ),
    class_="dashboard",
).compute("class", cond(field("dark"), "dashboard dark", "dashboard"))

styles = """
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: #eef2f7; }
  .dashboard { min-height: 100vh; box-sizing: border-box; padding: 2.5rem; color: #172033;
    background: radial-gradient(circle at top right, #cffafe, transparent 32%), #f8fafc;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif; transition: .2s ease; }
  .dashboard.dark { color: #e5eefb; background: radial-gradient(circle at top right, #164e63, transparent 32%), #0f172a; }
  .page-header, .metrics, .workspace-heading, .workspace-shell, .order-card { max-width: 78rem; margin-inline: auto; }
  .page-header, .workspace-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .eyebrow { margin: 0; color: #0891b2; font-size: .72rem; font-weight: 800; letter-spacing: .16em; }
  h1 { margin: .2rem 0 0; font-size: clamp(2rem, 5vw, 3.2rem); letter-spacing: -.045em; }
  h2 { margin: 0; font-size: 1.15rem; } p { margin: .35rem 0 0; color: #64748b; }
  .dark p { color: #94a3b8; }
  button, input, select { box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: .62rem; background: #fff; color: #334155;
    font: inherit; }
  button { padding: .62rem .9rem; cursor: pointer; font-weight: 750; }
  button:hover { border-color: #0891b2; color: #0e7490; background: #ecfeff; }
  .dark button, .dark input, .dark select { border-color: #475569; background: #1e293b; color: #e2e8f0; }
  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: .8rem; margin-block: 1.7rem; }
  .metrics article { padding: 1rem 1.15rem; border: 1px solid #dbe4ee; border-radius: .85rem; background: rgba(255,255,255,.9);
    box-shadow: 0 8px 24px rgba(15,23,42,.05); }
  .dark .metrics article, .dark .order-card { border-color: #334155; background: rgba(15,23,42,.82); }
  .metrics span { display: block; color: #64748b; font-size: .78rem; } .metrics strong { display: block; margin-top: .3rem; font-size: 1.35rem; }
  .live-metric { display: flex; align-items: center; gap: .55rem; } .live-metric strong { margin: 0; }
  .live-dot { width: .65rem; height: .65rem; border-radius: 50%; background: #10b981; box-shadow: 0 0 0 .28rem #d1fae5; }
  .workspace-heading { margin-bottom: .75rem; }
  .segmented { display: flex; gap: .45rem; }
  .workspace-shell { height: min(58vh, 34rem); overflow: hidden; border: 1px solid #cbd5e1; border-radius: 1rem; background: #fff;
    box-shadow: 0 18px 48px rgba(15,23,42,.12); }
  #market-grid { display: block; width: 100%; height: 100%; }
  .order-card { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 1rem; box-sizing: border-box; margin-top: 1rem;
    padding: 1rem; border: 1px solid #dbe4ee; border-radius: 1rem; background: rgba(255,255,255,.9); }
  .order-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }
  label { display: grid; gap: .38rem; color: #475569; font-size: .78rem; font-weight: 750; }
  .dark label { color: #cbd5e1; } input, select { width: 100%; min-height: 2.55rem; padding: .55rem .7rem; }
  .submit-button { min-height: 2.55rem; border-color: #0891b2; background: #0891b2; color: #fff; }
  .submit-button:hover { background: #0e7490; color: #fff; }
  .order-status { grid-column: 1 / -1; min-height: 1.2rem; margin: 0; color: #0891b2; font-size: .82rem; }
  .delete-dialog { max-width: min(28rem, calc(100vw - 4rem)); padding: 1.25rem; border: 1px solid #cbd5e1;
    border-radius: .85rem; background: #fff; color: #172033; }
  .dark .delete-dialog { border-color: #475569; background: #1e293b; color: #e5eefb; }
  .delete-dialog::backdrop { background: #0f172a66; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1.25rem; }
  @media (max-width: 760px) { .dashboard { padding: 1rem; } .page-header, .workspace-heading { align-items: flex-start; flex-direction: column; }
    .metrics { grid-template-columns: repeat(2, 1fr); } .order-card { grid-template-columns: 1fr; } .order-fields { grid-template-columns: 1fr; }
    .segmented { flex-wrap: wrap; } }
</style>
"""

routes = [
    Route("/api/trades", submit_trade, methods=["POST"]),
    Route("/api/trades/delete", delete_trade, methods=["POST"]),
    Route("/api/trades/copy", copy_trade, methods=["POST"]),
]
if not IS_PYODIDE:
    routes[:0] = [
        WebSocketRoute("/ws", transports.ws_endpoint(transport_server)),
        WebSocketRoute("/perspective", perspective_socket),
    ]

initial_store = {"view": "blotter", "dark": False, "symbol": "AAPL", "side": "Buy", "quantity": 100}

app = serve(
    page,
    packages=[package],
    wire="transports",
    routes=routes,
    background=[transports.autosync(transport_server), stream_trades()],
    store=initial_store,
    head=styles,
    title="spaday-perspective example",
)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8015)
