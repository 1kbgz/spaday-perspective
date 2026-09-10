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

The aliases map to `Pro Dark` and `Pro Light` (`spaday_perspective.THEMES`). A full Perspective
theme name is also accepted, so to use themes of your own, put their CSS on the page and compute
their names instead:

```python
panel.compute("theme", cond(field("dark"), "Acme Dark", "Acme Light"))
```

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
