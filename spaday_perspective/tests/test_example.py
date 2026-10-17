import asyncio

import httpx

from spaday_perspective import example


async def request(method: str, path: str, **kwargs):
    transport = httpx.ASGITransport(app=example.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://example") as client:
        return await client.request(method, path, **kwargs)


def test_example_serves_dashboard_and_accepts_trades():
    response = asyncio.run(request("GET", "/tree.json"))
    assert response.status_code == 200
    assert "perspective-panel" in response.text

    initial_count = example.row_count
    response = asyncio.run(request("POST", "/api/trades", json={"symbol": "nvda", "side": "sell", "quantity": 75}))
    assert response.status_code == 200
    assert response.json()["message"].startswith("Added 75 NVDA shares at $")
    assert example.row_count == initial_count + 1
    assert example.feed.row_count == f"{len(example.records):,}"


def test_example_deletes_by_index_and_validates_the_request():
    trade = example.append_trade(symbol="TEST", side="Buy", quantity=1, price=1)
    key = trade["id"]
    for body in ({}, [], {"id": True}, {"id": str(key)}):
        assert asyncio.run(request("POST", "/api/trades/delete", json=body)).status_code == 422
    response = asyncio.run(request("POST", "/api/trades/delete", json={"id": key}))
    assert response.json() == {"message": f"Deleted trade {key}"}
    assert key not in example.records
    view = example.trades.view(filter=[["id", "==", key]])
    try:
        assert view.to_records() == []
    finally:
        view.delete()
    assert asyncio.run(request("POST", "/api/trades/delete", json={"id": key})).status_code == 404


def test_copy_trade_returns_form_fields_without_mutating_records():
    trade = example.append_trade(symbol="COPY", side="Sell", quantity=23, price=12.34)
    before = dict(example.records)
    metrics = example.feed.model_dump()
    response = asyncio.run(request("POST", "/api/trades/copy", json={"id": trade["id"]}))
    assert response.json() == {"message": f"Copied trade {trade['id']} to form", "symbol": "COPY", "side": "Sell", "quantity": 23}
    assert example.records == before
    assert example.feed.model_dump() == metrics
    for body in ({}, [], {"id": True}, {"id": str(trade["id"])}):
        assert asyncio.run(request("POST", "/api/trades/copy", json=body)).status_code == 422
    example.remove_trade(trade["id"])
    assert asyncio.run(request("POST", "/api/trades/copy", json={"id": trade["id"]})).status_code == 404


def test_metrics_follow_retained_rows_and_rounded_prices(monkeypatch):
    monkeypatch.setattr(example, "trades", None)
    monkeypatch.setattr(example, "records", {})
    monkeypatch.setattr(example, "browser_updates", [])
    monkeypatch.setattr(example, "browser_removals", [])
    monkeypatch.setattr(example, "feed", example.MarketFeed())
    first = example.append_trade(symbol="A", side="Buy", quantity=100, price=12.345)
    second = example.append_trade(symbol="B", side="Sell", quantity=10, price=20)
    assert example.feed.row_count == "2"
    assert example.feed.notional == f"${100 * first['price'] + 200:,.0f}"
    assert example.feed.last_trade == "$20.00"
    example.remove_trade(second["id"])
    assert example.feed.row_count == "1"
    assert example.feed.notional == f"${100 * first['price']:,.0f}"
    assert example.feed.last_trade == f"${first['price']:.2f}"
    example.remove_trade(first["id"])
    assert example.feed.row_count == "0"
    assert example.feed.notional == "$0"
    assert example.feed.last_trade == "$0.00"


def test_browser_example_queues_removals_and_keeps_the_row_cap(monkeypatch):
    monkeypatch.setattr(example, "trades", None)
    monkeypatch.setattr(example, "records", {})
    monkeypatch.setattr(example, "browser_updates", [])
    monkeypatch.setattr(example, "browser_removals", [])
    monkeypatch.setattr(example, "row_count", 0)
    monkeypatch.setattr(example, "feed", example.MarketFeed())
    for _ in range(1_002):
        example.append_trade(symbol="TEST", side="Buy", quantity=1, price=1)
    assert len(example.records) == 1_000
    assert example.feed.row_count == "1,000"
    assert example.feed.notional == "$1,000"
    assert example.browser_removals == [1, 2]
    assert len(example.browser_updates) == 1_002
    response = asyncio.run(request("POST", "/api/trades/delete", json={"id": 3}))
    assert response.status_code == 200
    assert example.browser_removals == [1, 2, 3]
    assert len(example.records) == 999
    assert example.feed.row_count == "999"
    assert example.feed.notional == "$999"
