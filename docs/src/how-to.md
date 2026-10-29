# How to stream data and change layouts

## Open, close, and save channels

Configure channels by table name and enable the optional toolbar:

```python
panel = PerspectivePanel(
    id="workspace",
    toolbar=True,
    config={
        "ws_url": "/perspective",
        "channels": {
            "trades": {"title": "Trades", "plugin": "Datagrid", "columns": ["symbol", "price"]},
            "orders": {"title": "Orders", "plugin": "Datagrid"},
        },
        "single_tab": True,
        "layout": {
            "layout": {"type": "tab-layout", "tabs": ["trades"]},
            "panels": {"trades": {"table": "trades", "plugin": "Datagrid"}},
        },
    },
)
```

Host both tables on the Perspective server. Selecting **Orders** replaces the selected detail tab;
reopening **Trades** restores its columns, filters, sorting, and title. Omit `single_tab` to keep
multiple tabs. To use your own design-kit buttons, omit `toolbar` and attach these actions:

```python
from spaday import Invoke, Sequence, SetStorage, by_id, field

open_orders = Invoke(by_id("workspace"), "openChannel", "orders")
close_orders = Invoke(by_id("workspace"), "closeChannel", "orders")
save_layout = Sequence(
    Invoke(by_id("workspace"), "saveClean", result="saved_layout"),
    SetStorage("workspace-layout", field("saved_layout")),
)
```

Assign a saved or imported token to `config.layout` to restore it. Keep its `closed_channels` field:
`saveClean()` includes configurations for channels closed through either the wrapper or native tabs.
Use the same result with Spaday's `Download` action when exporting a layout.

Saved panel themes follow the current application theme when restored. For a filter sidebar that
must use its own theme, set `config.master_theme` and list its panel ID in the layout's `masters`.

## Embed a grid without internal tabs

Set `hide_tabs=True` when your application already supplies navigation:

```python
panel = PerspectivePanel(
    hide_tabs=True,
    config={
        "ws_url": "/perspective",
        "layout": {
            "panels": {"trades": {"table": "trades", "plugin": "Datagrid"}},
            "layout": {"type": "tab-layout", "tabs": ["trades"]},
        },
    },
).style(height="24rem", width="100%", min_width="0")
```

Give the grid a definite height, including inside a WebAwesome tab panel. `height="100%"` needs a
parent with a definite height; otherwise the grid can collapse. A sized grid observes its container
when the tab becomes visible and when the container resizes. No tab-show callback is required.

`hide_tabs` changes presentation only. For several channels, retain `toolbar=True` or supply
buttons calling `openChannel` as shown above. The example uses the wrapper toolbar with hidden
internal tabs.

## Export rows without action columns

Attach this action to your own button to download the configured view as CSV:

```python
from spaday import Download, Invoke, Sequence, by_id, field

export_trades = Sequence(
    Invoke(by_id("workspace"), "exportData", {"panel": "trades", "format": "csv"}, result="exported_trades"),
    Download("trades.csv", field("exported_trades"), "text/csv"),
)
```

Use `format="json"` in the options mapping for JSON text, or omit `panel` to export the active panel.
Filters and sorting still apply. This exports the configured view, not the selected cell block.

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

## Add a delete button to each row

Create the source table with a unique index, include that column in the Datagrid, and annotate it:

```python
from spaday import CallEndpoint, event_prop, obj
from spaday_perspective import PerspectivePanel

orders = client.table(rows, name="orders", index="id")
panel = PerspectivePanel(
    config=config,
    row_actions={"orders": {"id": {"action": "delete", "label": "Delete order"}}},
).on(
    "perspective-row-action",
    CallEndpoint("POST", "/orders/delete", obj({"id": event_prop("detail.key")}), result="reply"),
)
```

In the endpoint, validate the ID and the authenticated user's permission, then update authoritative
storage and call `orders.remove([key])`. Use `reply` to show success or rejection. Do not delete by
displayed row number or use a clicked group's filters as a bulk-delete predicate. If several actions
share a handler, validate the requested action and table against an allowlist too.

The main example (`python -m spaday_perspective.example`) and browser preview include delete buttons
in the live blotter. Both call the same Python deletion handler. The table retains up to 1,000 rows;
summary totals count all trades received, including deleted trades.

Run the smaller example with a locked-record policy using:

```sh
python -m spaday_perspective.row_actions
```

Open <http://127.0.0.1:8017> in two windows. Deleting an unlocked order updates both; locked orders
return an error. This local demo illustrates a record policy, not production authentication. Its
Perspective socket is application-owned; production hosts must also restrict client-side table writes.
For a mirrored table, configure its local `index` to match the authoritative index.

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

The aliases map to `Pro Dark` and `Pro Light` (`spaday_perspective.THEMES`). A full Perspective
theme name is also accepted, so to use themes of your own, put their CSS on the page and compute
their names instead:

```python
panel.compute("theme", cond(field("dark"), "Acme Dark", "Acme Light"))
```

## Configure selection and find a value

Enable region selection, cell-aligned scrolling, and Find from Python:

```python
from spaday_perspective import EditMode, PerspectivePanel, Theme

panel = PerspectivePanel(
    theme=Theme.DARK,
    toolbar=True,
    find=True,
    config={
        "ws_url": "/perspective",
        "layout": {
            "layout": {"type": "tab-layout", "tabs": ["trades"]},
            "panels": {
                "trades": {
                    "table": "trades",
                    "plugin": "Datagrid",
                    "plugin_config": {"edit_mode": EditMode.SELECT_REGION, "scroll_lock": True},
                },
            },
        },
    },
)
```

Select cells and press Ctrl+C / Cmd+C to copy. Press Ctrl+F / Cmd+F while the grid is focused, or click
Find, then choose a column and enter an exact value. Apply filter keeps existing filters. Use
Perspective Settings to change or remove them. Cancel leaves the data view unchanged.

The main Python example and browser preview include these controls. To use a custom Find button,
call `Invoke(by_id("your-panel-id"), "openFind")` from its click action; keep `find=True` on the panel.

## Persist user-edited layouts

`perspective-config-update` re-dispatches from the panel whenever the user edits the workspace —
drags a panel, changes a view, filters. Bind it to an endpoint to persist the edit:

```python
from spaday import CallEndpoint, event_value

panel.on("perspective-config-update", CallEndpoint("POST", "/api/layout", event_value()))
```

Serve the stored config back through `config["layout"]` on the next load. `panel.save()` (JS)
returns the same whole-element shape on demand.

## Mirror a table into a local worker

For tables that are read-heavy in the browser, mirror them client-side with a per-table
architecture — reads (scrolls, sorts, filters) stop round-tripping to Python:

```python
panel = PerspectivePanel(
    config={
        "ws_url": "/perspective",
        "tables": [
            {"name": "trades", "architecture": "client-server", "index": "symbol"},
            "orders",  # plain entries stay on the server
        ],
        "layout": layout,
    }
)
```

`index` and `limit` apply to the local copy. `default_architecture` flips the default for every
plain entry.

Mirrors resnapshot after source changes so deletions and replacements propagate correctly. Keep
large, high-frequency tables on the default server architecture to avoid full-table transfer on refresh.

## Share Perspective with your own library

Perspective registers global custom element names, so a second copy on the page throws from
`customElements.define`. If your library uses Perspective, import it by its bare specifiers and leave
those imports out of your bundle:

```js
// esbuild
await esbuild.build({
  entryPoints: ["src/index.js"],
  bundle: true,
  format: "esm",
  external: [
    "@perspective-dev/client",
    "@perspective-dev/viewer",
    "@perspective-dev/viewer-charts",
    "@perspective-dev/viewer-datagrid",
  ],
});
```

Serve your bundle as a module next to `packages=["perspective"]`; the page's import map resolves those
imports to the copy this package already loaded. Import `@perspective-dev/viewer` dynamically —
`import("@perspective-dev/viewer")` — rather than statically: it instantiates its WASM with a
top-level await, so a static import holds back your whole module, and any element it defines, until
the binary has loaded, and spaday can mount the page before your element exists.

To share the engine itself rather than just the modules, borrow it:
`globalThis.__spadayPerspective.client(url)` returns the websocket client the panels use for that
server, and `.worker()` the shared local engine.
