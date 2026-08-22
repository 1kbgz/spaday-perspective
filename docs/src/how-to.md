# How to stream data and change layouts

## Stream rows from Python

Keep the table returned by `client.table()`, then update it whenever application data changes:

```python
trades = client.table(schema, limit=1_000, name="trades")

trades.update(
    [
        {
            "symbol": "NVDA",
            "quantity": 50,
            "price": 182.40,
        }
    ]
)
```

Connected viewers receive the update through Perspective's websocket. Do not copy bulk rows into a
spaday store.

## Switch between saved layouts

Build two workspace layouts and compute `config` from a small reactive field:

```python
from spaday import SetField, cond, element, eq, field, obj
from spaday_perspective import PerspectivePanel

panel = PerspectivePanel().compute(
    "config",
    obj(
        {
            "ws_url": "/perspective",
            "tables": ["trades"],
            "layout": cond(
                eq(field("view"), "grouped"),
                grouped_layout,
                blotter_layout,
            ),
        }
    ),
)

controls = element(
    "nav",
    element("button").text("Blotter").on("click", SetField("view", "blotter")),
    element("button").text("By symbol").on("click", SetField("view", "grouped")),
)
```

Pass `store={"view": "blotter"}` to `serve()`. Changing the field restores only the new layout; it does
not reconnect the table websocket.

## Map a page theme

Perspective uses its own theme names. Compute the wrapper property explicitly:

```python
from spaday import cond, field

panel.compute("theme", cond(field("dark"), "dark", "light"))
```

The aliases map to `Pro Dark` and `Pro Light`. A full Perspective theme name is also accepted.

## Persist user-edited layouts

`perspective-config-update` re-dispatches from the panel whenever the user edits the workspace —
drags a panel, changes a view, filters. Bind it to an endpoint to persist the edit:

```python
from spaday import CallEndpoint, event_value

panel.on("perspective-config-update", CallEndpoint("POST", "/api/layout", event_value()))
```

Serve the stored config back through `config["layout"]` on the next load. `panel.save()` (JS)
returns the same whole-element shape on demand.
