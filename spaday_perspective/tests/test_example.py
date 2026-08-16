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
