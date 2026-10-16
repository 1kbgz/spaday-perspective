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
    assert example.feed.row_count == f"{example.row_count:,}"


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


def test_browser_example_queues_removals_and_keeps_the_row_cap(monkeypatch):
    monkeypatch.setattr(example, "trades", None)
    monkeypatch.setattr(example, "records", {})
    monkeypatch.setattr(example, "browser_updates", [])
    monkeypatch.setattr(example, "browser_removals", [])
    monkeypatch.setattr(example, "row_count", 0)
    monkeypatch.setattr(example, "total_notional", 0)
    monkeypatch.setattr(example, "feed", example.MarketFeed())
    for _ in range(1_002):
        example.append_trade(symbol="TEST", side="Buy", quantity=1, price=1)
    assert len(example.records) == 1_000
    assert example.browser_removals == [1, 2]
    assert len(example.browser_updates) == 1_002
    response = asyncio.run(request("POST", "/api/trades/delete", json={"id": 3}))
    assert response.status_code == 200
    assert example.browser_removals == [1, 2, 3]
    assert len(example.records) == 999
    assert example.feed.row_count == "1,002"
