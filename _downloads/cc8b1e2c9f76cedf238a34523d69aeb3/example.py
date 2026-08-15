import asyncio
import logging
from datetime import UTC, datetime

import perspective
import transports
import uvicorn
from perspective.handlers.starlette import PerspectiveStarletteHandler
from pydantic import BaseModel
from spaday import CallEndpoint, SetField, ToggleField, cond, element, eq, field, obj
from spaday.backends.starlette import serve
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from spaday_perspective import PerspectivePanel, package

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
    limit=1_000,
    name="trades",
)

symbols = ("AAPL", "MSFT", "NVDA", "AMZN", "META")
venues = ("XNAS", "XNYS", "ARCX", "BATS")
row_count = 0
total_notional = 0.0


def append_trade(*, symbol: str, side: str, quantity: int, price: float) -> dict:
    global row_count, total_notional
    row_count += 1
    total_notional += quantity * price
    trade = {
        "id": row_count,
        "time": datetime.now(UTC).strftime("%H:%M:%S"),
        "symbol": symbol,
        "side": side,
        "quantity": quantity,
        "price": round(price, 2),
        "venue": venues[row_count % len(venues)],
    }
    trades.update([trade])
    feed.row_count = f"{row_count:,}"
    feed.last_trade = f"${price:,.2f}"
    feed.notional = f"${total_notional:,.0f}"
    feed.stream_status = "Live"
    return trade


for index in range(80):
    append_trade(
        symbol=symbols[index % len(symbols)],
        side="Buy" if index % 3 else "Sell",
        quantity=25 + (index * 17) % 450,
        price=round(118 + index * 0.73 + (index % 7) * 1.21, 2),
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
        "columns": ["time", "symbol", "side", "quantity", "price", "venue"],
        "sort": [["id", "desc"]],
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
    return {
        "sizes": [1],
        "detail": {"main": {"type": "tab-area", "widgets": ["market"], "currentIndex": 0}},
        "master": {"sizes": [], "widgets": []},
        "mode": "globalFilters",
        "viewers": {"market": viewer},
    }


panel = (
    PerspectivePanel(id="market-grid")
    .compute("theme", cond(field("dark"), "dark", "light"))
    .compute(
        "config",
        obj(
            {
                "ws_url": "/perspective",
                "tables": ["trades"],
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
            element("p", class_="lede").text("Native columnar streaming with server-authoritative orders and reactive controls."),
        ),
        element("button", class_="theme-button").text("Toggle theme").on("click", ToggleField("dark")),
        class_="page-header",
    ),
    element(
        "section",
        element("article", element("span").text("Rows received"), element("strong").bind("textContent", "row_count")),
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
            element("p").text("Rows stream over Perspective's websocket; only summary state uses transports."),
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
  @media (max-width: 760px) { .dashboard { padding: 1rem; } .page-header, .workspace-heading { align-items: flex-start; flex-direction: column; }
    .metrics { grid-template-columns: repeat(2, 1fr); } .order-card { grid-template-columns: 1fr; } .order-fields { grid-template-columns: 1fr; }
    .segmented { flex-wrap: wrap; } }
</style>
"""

app = serve(
    page,
    packages=[package],
    wire="transports",
    routes=[
        WebSocketRoute("/ws", transports.ws_endpoint(transport_server)),
        WebSocketRoute("/perspective", perspective_socket),
        Route("/api/trades", submit_trade, methods=["POST"]),
    ],
    background=[transports.autosync(transport_server), stream_trades()],
    store={"view": "blotter", "dark": False, "symbol": "AAPL", "side": "Buy", "quantity": 100},
    head=styles,
    title="spaday-perspective example",
)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8015)
