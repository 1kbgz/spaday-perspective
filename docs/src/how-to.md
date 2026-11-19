# How to stream data and change layouts

## Open table panels and save workspaces

Set default panel configurations by table name:

```python
panel = PerspectiveViewer(
    id="workspace",
    config={
        "ws_url": "/perspective",
        "panel_defaults": {
            "trades": {"title": "Trades", "plugin": "Datagrid", "columns": ["symbol", "price"]},
            "orders": {"title": "Orders", "plugin": "Datagrid"},
        },
        "restore_selected_tabs_only": True,
        "workspace": {
            "layout": {"type": "tab-layout", "tabs": ["trades"]},
            "panels": {"trades": {"table": "trades", "plugin": "Datagrid"}},
        },
    },
)
```

Host both tables on the Perspective server. Selecting **Orders** replaces the selected detail tab;
reopening **Trades** restores its columns, filters, sorting, and title. Omit `restore_selected_tabs_only` to keep
multiple tabs. To use your own design-kit buttons:

```python
from spaday import Invoke, Sequence, SetStorage, by_id, field

open_orders = Invoke(by_id("workspace"), "openTablePanel", "orders")
close_orders = Invoke(by_id("workspace"), "closeTablePanels", "orders")
save_layout = Sequence(
    Invoke(by_id("workspace"), "savePortableWorkspace", result="saved_layout"),
    SetStorage("workspace-layout", field("saved_layout")),
)
```

Assign a saved or imported token to `config.workspace` to restore it. Keep its `retained_panel_configs_by_table` field:
`savePortableWorkspace()` includes retained configurations for panels closed through either the wrapper or native tabs.
Use the same result with Spaday's `Download` action when exporting a layout.

Saved panel themes follow the current application theme when restored.

## Select and filter a table

Use `showTable` to select a table's detail panel and update filters in one action:

```python
from spaday import Invoke, by_id, element

element("button").text("Buy trades").on(
    "click",
    Invoke(
        by_id("workspace"), "showTable", "trades",
        {"filter": [["side", "==", "Buy"]]}, result="shown",
    ),
)
```

Declare `trades` in `config.panel_defaults` or `config.tables`. If only a master panel shows the table,
this opens a separate detail panel using the panel defaults. Existing filters on other columns
remain; the action replaces only the `side` clauses. The result field contains the selected panel ID
for later `restorePanel` or `export` actions.

## Set application defaults before loading

Create the wrapper without a connection config, then set defaults before assigning that config.
For example, this Python-authored button initializes defaults and opens the workspace:

```python
from spaday import Invoke, Sequence, SetProp, by_id, element
from spaday_perspective import PerspectiveViewer

panel = PerspectiveViewer(id="workspace")
open_workspace = element("button").text("Open workspace").on(
    "click",
    Sequence(
        Invoke(
            by_id("workspace"), "setPluginConfigDefaults",
            {"scroll_lock": True}, {"plugin": "Datagrid"}, result="plugin_defaults_set",
        ),
        Invoke(
            by_id("workspace"), "setColumnConfigDefaults",
            {"date_format": {"timeZone": "UTC"}}, {"type": "datetime"},
            result="column_defaults_set",
        ),
        SetProp(by_id("workspace"), "config", {
            "ws_url": "/perspective",
            "workspace": {
                "layout": {"type": "tab-layout", "tabs": ["trades"]},
                "panels": {"trades": {"table": "trades", "plugin": "Datagrid"}},
            },
        }),
    ),
)
```

Include `panel` and `open_workspace` in the page and host a `trades` table. The `result` arguments
make the sequence await each setter before loading. To initialize automatically, run the same
sequence in a spaday initial effect. Complete it before loading any other Perspective viewers:
these defaults apply to the entire page, not just `workspace`.

Use `getPluginConfigDefaults` and `getColumnConfigDefaults` with `Invoke(..., result="defaults")`
to inspect the registry. Pass `None` as the defaults argument to remove all defaults for the
specified options. See [configuration defaults](reference.md#configuration-defaults) for scope
and removal semantics.

## Add a Find control

Use a Python-authored dialog with a column picker and a value input, then call `showTable` with
`{"filter": [[column, "==", value]]}`. Use numeric values for numeric columns. The
[market-monitor example](https://github.com/1kbgz/spaday-perspective/blob/main/spaday_perspective/example.py)
validates its input before applying the filter and closes the dialog only after the action succeeds.
It leaves browser Find shortcuts unchanged.

## Embed a sized grid

Give the grid a definite height, including inside a WebAwesome tab panel. `height="100%"` needs a
parent with a definite height; otherwise the grid can collapse. A sized grid observes its container
when the tab becomes visible and when the container resizes. No tab-show callback is required.

## Export rows

Attach this action to your own button to download the configured view as CSV through the viewer's
`export`:

```python
from spaday import Download, Invoke, Sequence, by_id, field

export_trades = Sequence(
    Invoke(by_id("workspace"), "export", {"panel": "trades", "method": "csv"}, result="exported_trades"),
    Download("trades.csv", field("exported_trades"), "text/csv"),
)
```

`method` is Perspective's `ExportMethod`: `json` for an object of columns, `csv-selected` for the
selected cells, and so on. Omit `panel` to export the active panel. Filters and sorting apply.

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

Create the source table with a unique index, set a command schema from a page script, and handle
`perspective-command` in Python. The schema is a function, so Python cannot author it:

```python
from spaday import CallEndpoint, event_prop, obj
from spaday.backends.starlette import serve
from spaday_perspective import PerspectiveViewer, package

orders = client.table(rows, name="orders", index="id")
panel = PerspectiveViewer(id="orders", config=config).on(
    "perspective-command",
    CallEndpoint("POST", "/orders/delete", obj({"id": event_prop("detail.context.hit.id")}), result="reply"),
)

commands = """
<script type="module">
  const commands = [{ kind: "Command", key: "delete", label: "", icon: "delete", title: "Delete order" }];
  const schema = ({ table, hit }) => ({
    commands: table === "orders" && hit?.id?.length && !hit.row_path.length ? commands : [],
  });
  await customElements.whenDefined("perspective-panel");
  let panel;
  while (!(panel = document.querySelector("#orders"))) await new Promise(requestAnimationFrame);
  await panel.setCommandSchema(schema, { scopes: ["datagrid-row"] });
</script>
"""

app = serve(panel, packages=[package], head=commands)
```

The Datagrid draws the button in its command column on every flat row; the `hit` test leaves
grouped rows and the total row without one, since their `id` is a group path, not an order.
`detail.context.hit.id` is the row's index values as a list, `[7]` for the order whose `id` is 7.

In the endpoint, validate the ID and the authenticated user's permission, then update authoritative
storage and call `orders.remove([key])`. Use `reply` to show success or rejection. Do not delete by
displayed row number or use a clicked group's filters as a bulk-delete predicate. If several
commands share a handler, validate `detail.key` and `detail.context.table` against an allowlist too.

The main example (`python -m spaday_perspective.example`) and browser preview include copy and
delete buttons in the live blotter. Both call the same Python deletion handler. The table retains up
to 1,000 rows; summary totals count all trades received, including deleted trades.

Run the smaller example with a locked-record policy using:

```sh
python -m spaday_perspective.commands
```

Open <http://127.0.0.1:8017> in two windows. Deleting an unlocked order updates both; locked orders
return an error. This local demo illustrates a record policy, not production authentication. Its
Perspective socket is application-owned; production hosts must also restrict client-side table writes.
For a mirrored table, configure its local `index` to match the authoritative index.

## Add the agent

Configure the viewer's embedded agent once, then send prompts from your own controls. Point `url`
at a same-origin endpoint that forwards OpenAI-style chat completions and adds the API key on the
server, so the key never reaches the page:

```python
from spaday import CallEndpoint, Invoke, Sequence, SetField, by_id, element, event_prop, field, obj

DOCS = "/components/perspective/vendor/@perspective-dev/viewer/dist/docs/perspective-docs.json"

configure = Sequence(
    CallEndpoint("GET", DOCS, result="agent_docs"),
    Invoke(
        by_id("workspace"), "agentConfig",
        obj({"url": "/api/llm/chat/completions", "model": "claude-opus-5", "docs": field("agent_docs.body")}),
    ),
)
ask = Invoke(by_id("workspace"), "agentPrompt", field("prompt"), result="answer")
reset = Invoke(by_id("workspace"), "agentReset")

panel.on("perspective-agent-tool", SetField("last_tool", event_prop("detail")))
element("button").text("Ask").on("click", ask)
```

Run `configure` from a button or a spaday initial effect before the first prompt. `answer` holds
the agent's reply, and `last_tool` the JSON string of the latest tool call. See
[Methods](reference.md#methods) for what Python cannot pass.

## Switch between saved workspaces

Build two workspace layouts and compute `config` from a small reactive field:

```python
from spaday import SetField, cond, element, eq, field, obj
from spaday_perspective import PerspectiveViewer

panel = PerspectiveViewer().compute(
    "config",
    obj(
        {
            "ws_url": "/perspective",
            "tables": ["trades"],
            "workspace": cond(
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

## Configure selection

Enable region selection and cell-aligned scrolling from Python:

```python
from spaday_perspective import EditMode, PerspectiveViewer, Theme

panel = PerspectiveViewer(
    theme=Theme.DARK,
    config={
        "ws_url": "/perspective",
        "workspace": {
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

Select cells and press Ctrl+C / Cmd+C to copy them as CSV. A button outside the grid copies the
same selection with `Invoke(by_id("workspace"), "copy", {"method": "csv-selected"})`, and the whole
view with `copy` and no options; see [Methods](reference.md#methods).

## Persist user-edited layouts

`perspective-config-update` re-dispatches whenever the user edits the workspace —
drags a panel, changes a view, filters. Save the whole workspace before sending it to your endpoint:

```python
from spaday import CallEndpoint, Invoke, Sequence, by_id, field

panel.on(
    "perspective-config-update",
    Sequence(
        Invoke(by_id("workspace"), "saveWorkspace", result="saved_workspace"),
        CallEndpoint("POST", "/api/layout", field("saved_workspace")),
    ),
)
```

Give the wrapper `id="workspace"`. Serve the stored token back through `config["workspace"]` on
the next load.

## Mirror a table into a local worker

For tables that are read-heavy in the browser, mirror them client-side with a per-table
architecture — reads (scrolls, sorts, filters) stop round-tripping to Python:

```python
panel = PerspectiveViewer(
    config={
        "ws_url": "/perspective",
        "tables": [
            {"name": "trades", "architecture": "client-server", "index": "symbol"},
            "orders",  # plain entries stay on the server
        ],
        "workspace": layout,
    }
)
```

Omit `index` and `limit` to inherit the source table's options, or specify them for the local copy.
A local `limit` is ignored with a warning when the source table is indexed.
Use `default_architecture` to set the architecture for plain table-name entries.

Perspective creates the local table from a source view and maintains the replica as rows change,
including deletions, clear, and replace operations. Choose the default server architecture when
the table should remain on the server rather than occupy browser memory.

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
