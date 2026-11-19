# API reference

## `PerspectiveViewer`

Tag: `<perspective-panel>`. `PerspectiveViewer` aliases the existing validated `PerspectivePanel`
class; both imports serialize to the same tag. The wrapper manages a multi-panel workspace.

| Prop        | Type        | Description                                                              |
| ----------- | ----------- | ------------------------------------------------------------------------ |
| `config`    | mapping     | Connection, table names, and workspace layout.                           |
| `theme`     | `str`       | `light`, `dark`, or a Perspective theme name.                            |
| `themes`    | `list[str]` | Theme names offered by the status-bar picker (same shorthands accepted). |
| `autosize`  | `bool`      | Auto-size mode (on by default).                                          |
| `autopause` | `bool`      | Pause rendering while not visible (on by default).                       |
| `throttle`  | `int`       | Render throttle in milliseconds; unset restores adaptive throttling.     |
| `settings`  | `bool`      | Whether the settings sidebar is open.                                    |

```{eval-rst}
.. autoclass:: spaday_perspective.PerspectiveViewer
   :members:
```

## Configuration defaults

The following are the viewer's static configuration-default methods, passed through with their
arguments unchanged. They are instance methods here so that `Invoke` can reach them, and they
return promises: each waits for Perspective initialization and runs through the panel's lifecycle
queue, so a `Sequence` can order a setter before a config.

| Method                                        | Arguments                                    | Result                                       |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `setPluginConfigDefaults(defaults, options?)` | Mapping or `null`; optional `{plugin}`       | No value                                     |
| `getPluginConfigDefaults()`                   | None                                         | List of `{defaults, plugin?}` entries        |
| `setColumnConfigDefaults(defaults, options?)` | Mapping or `null`; optional `{plugin, type}` | No value                                     |
| `getColumnConfigDefaults()`                   | None                                         | List of `{defaults, plugin?, type?}` entries |

Defaults apply to **every Perspective viewer on the page**, including viewers outside this wrapper.
Set them before assigning connection/workspace config or restoring any viewer. Separate wrappers
have separate lifecycle queues; the application must finish initialization before loading them.
Removing a wrapper does not remove defaults. Saved workspaces omit defaults and do not contain the
application's defaults registry.

Each setter merges values for the same options. A `null` value removes a key at any depth;
`defaults=null` removes all defaults for those options. Column types are `integer`, `float`,
`string`, `boolean`, `date`, and `datetime`. Perspective validates arguments and applies scope
precedence and format merging. See its [configuration defaults reference](https://perspective-dev.github.io/guide/how_to/javascript/config_defaults.html).

`find` and `openFind` are not wrapper APIs. The market-monitor example implements its Find dialog
with Python components and the general `showTable` method.

## Terminology and compatibility

A **table** holds data. A **view** defines a query over a table. A **panel** displays a view in a
workspace. A **workspace** contains the layout tree and panel configurations.

The following legacy names remain supported:

| Canonical name                      | Compatibility name   |
| ----------------------------------- | -------------------- |
| `PerspectiveViewer`                 | `PerspectivePanel`   |
| `config.workspace`                  | `config.layout`      |
| `config.panel_defaults`             | `config.channels`    |
| `config.restore_selected_tabs_only` | `config.single_tab`  |
| `openTablePanel(name)`              | `openChannel(name)`  |
| `closeTablePanels(name)`            | `closeChannel(name)` |
| `saveWorkspace()`                   | `save()`             |
| `savePortableWorkspace()`           | `saveClean()`        |

Supplying both config names requires structurally equal values; conflicting values raise an error.
The config getter preserves the supplied keys. Workspace JSON strings are accepted; when supplying
both workspace aliases, their values must use the same representation.

Canonical save methods write the wrapper extension `retained_panel_configs_by_table`. Legacy save
methods keep writing `closed_channels`; restores accept either key and reject conflicting mappings.
Both mappings store one last panel configuration per table, only for tables without open panels.
The wrapper removes this metadata before calling native `restoreWorkspace()`. Panel IDs are opaque;
existing `channel:` prefixes remain valid.

These methods are wrapper conveniences. Native `viewer.save()` saves an individual panel;
`viewer.saveWorkspace()` saves the workspace. Native `addPanel`/`removePanel` operate on panel IDs,
while `closeTablePanels` removes every panel for a table, including master panels.

## Configuration

| Key                          | Type    | Description                                                                                                                                                                                                                  |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws_url`                     | `str`   | Perspective websocket URL; relative URLs use the current host.                                                                                                                                                               |
| `local`                      | `bool`  | Load the shared in-browser Perspective worker instead of opening a websocket.                                                                                                                                                |
| `tables`                     | `list`  | Table names (`str`), or `{name, architecture, index, limit}` mappings for per-table architecture.                                                                                                                            |
| `default_architecture`       | `str`   | `server` (default) or `client-server`, applied to `tables` entries without their own `architecture`.                                                                                                                         |
| `workspace`                  | mapping | Workspace config accepted by `<perspective-viewer>.restoreWorkspace()`, plus optional `retained_panel_configs_by_table`.                                                                                                     |
| `wait_for_table`             | `bool`  | Leave a panel whose `table` no loaded client hosts yet empty and pending until it is created, instead of erroring (the default).                                                                                             |
| `panel_defaults`             | mapping | Table name to default panel configuration, such as `{"trades": {"title": "Trades", "columns": ["price"]}}`. Supplies the table picker and default configs; declared tables also support `openTablePanel`/`closeTablePanels`. |
| `restore_selected_tabs_only` | `bool`  | Keep only the selected tab in each stack before restoring it. Hidden configured tables retain their settings for reopening. Default `False`.                                                                                 |

Changing `ws_url` opens a new client connection. Changing the serialized `workspace` restores the viewer's panels.
The wrapper queues asynchronous changes in assignment order.

For a `client-server` mirror, omitted `index` and `limit` options are inherited from the source table.
Explicit options apply to the local copy, except that `limit` is ignored with a warning when the
source table is indexed. Composite indexes are supported.

### Validation and enums

The public `spaday_perspective.PerspectiveViewer` validates literal configuration when serialized
with `to_node()` (including through `serve()` or a widget). This includes `.prop("config", ...)`
updates. `validate_config(config)` performs the same check explicitly and raises `ValueError`
with a path such as `config.layout` or `config.panel_defaults.trades`. Browser property setters
validate reactive config updates before accepting them. Computed expressions are checked when
their result reaches the browser, not while authoring the expression.

The wrapper checks its own settings: flags, table descriptors, and the aliases. Perspective's
`migrate` checks the layout and each configured panel (`panel_defaults`, retained configurations)
against its schema ahead of time, naming the offending value by JSON pointer, such as
`` config.layout: migrated config is invalid at `/panels/grid`: … ``. Information a layout upgrade
would drop is rejected the same way. Plugin settings, theme names, and table and column names are
the viewer's to check when the layout is applied; it reports through `perspective-error`, for
example `` Invalid `plugin_config.edit_mode`: … ``. The Python enums below are checked against the
installed Datagrid's declarations.

In the browser, the schema check needs Perspective's `migrate` binary, which the bundle loads
alongside the viewer. A layout assigned before it arrives is checked when it is applied and
reported through `perspective-error`; from then on `config` throws `TypeError` as it does for the
wrapper's own settings. Any panel's `perspective-ready` follows that load.
Without `perspective-python` installed, as in the Pyodide example, the Python check passes
layouts through to the browser.

Python string enums are exported for configuration:

- `EditMode`: `EDIT`, `READ_ONLY`, `SELECT_ROW`, `SELECT_COLUMN`, `SELECT_REGION`, `SELECT_ROW_TREE`.
- `Alignment`: `TOP_LEFT`, `TOP`, `TOP_RIGHT`, `LEFT`, `CENTER`, `RIGHT`, `BOTTOM_LEFT`, `BOTTOM`, `BOTTOM_RIGHT`.
- `Theme`: `LIGHT`, `DARK`, `PRO_LIGHT`, `PRO_DARK`.

Enum members serialize to Perspective's string values. Plain strings remain accepted.
Application-defined theme names remain valid. The scroll setting is `plugin_config.scroll_lock`, a
boolean, not an enum.

Perspective 4 workspace envelopes (`viewers`, `detail`, `master`) are migrated before restoration.
Migration preserves panel configuration, selected tabs, master panels, and split proportions. Missing
or empty split sizes use equal shares; a missing master/detail split uses 25/75. Version 5 layouts are
unchanged by migration, which keeps the wrapper's `retained_panel_configs_by_table` and
`closed_channels` and checks the result against Perspective's schema.

`spaday_perspective.migrate_layout(layout)` accepts a mapping or JSON string and returns the same
representation without modifying the input. Existing v5 layouts and invalid JSON strings pass
through unchanged. The browser bundle exports the mapping-only equivalent, `migrateLayout(layout)`,
which returns a promise.

The application theme overrides saved panel themes before restoration, master panels included.
Input layouts are copied before preparation. Restoring a saved layout does not require a second
theme restore.

Changing `restore_selected_tabs_only` with an unchanged layout applies to the current workspace,
preserving user edits. Turning `restore_selected_tabs_only` off permits additional tabs; it does not reopen closed
panels. Replacing `workspace` starts a new workspace and replaces its retained panel configurations.

`local=True` expects named tables to be created through `globalThis.__spadayPerspective.worker()` before the panel loads. It is intended for browser-only hosts such as the bundled Pyodide example; normal Python deployments should keep bulk data on Perspective's websocket.

## Table architectures

A `server` table (the default) reads over the websocket: every scroll, sort, and filter round-trips
to the Python server. A `client-server` table mirrors into a local Web Worker engine: the wrapper
opens a view of the server table and passes it to the worker's `table(view, options)` API.
The worker client loads before the websocket client so the local copy wins the viewer's table-name
lookup. Reads are then local; the server stays authoritative for writes. Set architectures in the
initial `config` — changing the mirrored set later reconnects.

Perspective's native mirroring maintains the replica through source updates, removals, clear, and
replace operations. Wrappers using the same connection, table, and mirror options share a local
table and subscription. The server architecture keeps the data on the server; a client-server
mirror stores a copy in browser memory.

## Commands

`setCommandSchema(schema, options?)` is the viewer's own method, passed through unchanged. `schema`
is a synchronous function from Perspective's command context to `{commands}`, or `null` to remove
it; `options.scopes` lists the surfaces it is evaluated for: `context-menu` (the default),
`datagrid-row`, `datagrid-cell` and `chart-tooltip`. Called before the panel is connected, the
schema is held and set ahead of the first workspace restore. See Perspective's
[custom commands guide](https://perspective-dev.github.io/guide/how_to/javascript/commands.html)
for the context, `hit` and `CommandSpec`.

The schema is a function, so it is set from a script on the page; Python cannot author it. Python
handles the result:

```html
<script type="module">
  const commands = [{ kind: "Command", key: "delete", label: "", icon: "delete", title: "Delete order" }];
  // a grouped row's `id` is its group path and the total row's is empty; neither is an order
  const schema = ({ table, hit }) => ({
    commands: table === "orders" && hit?.id?.length && !hit.row_path.length ? commands : [],
  });
  await customElements.whenDefined("perspective-panel");
  let panel;
  while (!(panel = document.querySelector("#orders"))) await new Promise(requestAnimationFrame);
  await panel.setCommandSchema(schema, { scopes: ["datagrid-row"] });
</script>
```

Pass the script to `serve(head=...)`. `icon` names a `--psp-icon--<name>--mask-image` property on
the viewer: Perspective's themes define `copy`, `close`, `export` and others, and this package adds
`delete`, `add` and `share`. An empty `label` with an `icon` gives an icon-only button whose
`title` is its tooltip and accessible name.

Picking a command fires `perspective-command`, re-dispatched from the panel, with `{key, context}`:

```python
panel.on(
    "perspective-command",
    CallEndpoint("POST", "/orders/delete", obj({"id": event_prop("detail.context.hit.id")})),
)
```

`detail.context.hit.id` is a list of the table's index values, `[7]` for an order whose `id` is 7
and the key tuple in index order for a composite index.
The application owns authorization, confirmation and mutation; nothing changes automatically. A
handler that changes state the schema reads calls `viewer.invalidate()` to redraw the buttons.

The Datagrid places its command column by `plugin_config.command_column` (`left` by default,
`right`, `tree` after the group columns, or `none`) and shows cell buttons while
`plugin_config.command_cells` is true. Both are per-panel plugin config in `config.workspace`,
saved by Perspective. The Datagrid accepts them only once it has drawn with the scope declared, so
they are dropped from the workspace a page loads with; apply them afterwards with `restorePanel`.
The schema itself is not saved and survives restores.

Migrating from `row_actions`, removed in 0.9.0:

| `row_actions`                                                  | Commands                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| the `row_actions` prop                                         | a page script calling `setCommandSchema`                                               |
| table name key                                                 | test `context.table` in the schema                                                     |
| indexed column key                                             | scope `datagrid-cell`, testing `hit.column_names`                                      |
| `@` dedicated column with `position`                           | scope `datagrid-row`; the side is `plugin_config.command_column`                       |
| `header`                                                       | gone; the command column has no header text                                            |
| `action`                                                       | `key`                                                                                  |
| `label`                                                        | `title`                                                                                |
| `text`                                                         | `label`, empty for an icon-only button                                                 |
| disabled on grouped, split or unindexed rows                   | return no commands unless `hit.id` is non-empty and `hit.row_path` is empty            |
| `perspective-row-action` `{action, panel, table, column, key}` | `perspective-command` `{key, context}`; the row key is `context.hit.id`, always a list |
| `TOKENS` and `--spa-perspective-action-*`                      | gone; buttons follow the Perspective theme                                             |

## Events

The viewer's observational events reach the panel as bubbling DOM events usable from spaday's
`.on(...)`; the panel re-dispatches the ones Perspective does not bubble itself: `perspective-click`, `perspective-select`,
`perspective-global-filter`, `perspective-global-filter-update`, `perspective-config-update`,
`perspective-toggle-settings`, `perspective-statusbar-pointerdown`, `perspective-table-delete`,
`perspective-active-panel-update`, `perspective-command`, and `perspective-agent-tool`.
`perspective-config-update` fires on user edits (layout drags, view changes, filters). A handler can
call `saveWorkspace()` to capture the whole workspace for persistence; the event payload is not a
workspace token. Two wrapper lifecycle events complete the picture:
`perspective-ready` fires once, after the panel has connected, loaded its tables, and applied and
rendered its initial workspace config — the signal to dismiss a branded startup overlay — and
`perspective-error` fires when a config apply fails (connection, mirror, or restore), with the error
in `detail`, so a host can swap its loader for an error state. The cancelable `*-before` events are not re-dispatched; attach to
the viewer directly for those.

## Methods

`copy(options?)` and `export(options?)` are the viewer's own methods, passed through unchanged.
`options` is Perspective's `ExportOptions`, `{method?, panel?}`: `method` is an `ExportMethod`
(`csv` by default; `csv-selected`, `json`, `json-selected`, `arrow`, `plugin`, ...) and `panel`
defaults to the active panel. `export` resolves to the data in that method's type, a string for the
CSV methods and an object of columns for the JSON ones; it is what the example's **Export CSV**
button downloads. `copy` writes the
data to the clipboard from within a user gesture, so call it directly from a click handler. It
rejects when the write fails or is denied, and a `-selected` method rejects with
"Nothing is selected" when the panel has no selection. Copying needs a secure context (HTTPS or
localhost); there is no fallback.

Two button patterns follow. A whole-view button calls `copy()` and is always enabled. A
selected-view button calls `copy({"method": "csv-selected"})` and is disabled until
`perspective-select` reports a non-null detail, re-reading `viewer.getSelection()` when
`perspective-active-panel-update` fires, since both address the active panel. A copy snapshots the
selection when called, so later selection, focus or config changes do not alter what is written.
Clicking a panel's body activates it, so a button outside the panel needs no focus tracking.

Ctrl+C and Cmd+C inside a grid call `copy({"method": "csv-selected", "panel": <that grid>})`. The
panel adds no selection guard, so Perspective's rejections are reported as `perspective-copy-error`
with `{message, error}`; the application owns notifications. Inputs, editable content, and ordinary
browser text selections keep native copying.

`agentConfig(config)`, `agentPrompt(prompt)` and `agentReset()` are the viewer's own methods for its
embedded LLM agent, passed through unchanged; see Perspective's documentation for `config`. All
three take JSON, so Python dispatches them with `Invoke`, and `agentPrompt` resolves with the
agent's reply for `result=`. `perspective-agent-tool` is re-dispatched from the panel for each tool
the agent calls. The agent's `docs` bundle is served at
`components/perspective/vendor/@perspective-dev/viewer/dist/docs/perspective-docs.json`. Limits:

- `config.engine`, and `config.docs` as a `Response` or a promise, are in-page objects; set those
  from a page script calling `panel.agentConfig(...)`. From Python, pass `docs` as the parsed bundle.
- An `apiKey` passed from Python is visible in the page. Point `url` at a same-origin proxy that
  adds the key on the server.
- A failed `agentPrompt` rejects with an error carrying `retry()`, which `Invoke` cannot reach;
  invoke `agentPrompt` again.
- The `perspective-agent-tool` detail is a JSON string of `{name, args}`, so `event_prop("detail")`
  is that string and `detail.name` does not resolve.
- The configuration is not saved with the workspace, and `agentConfig` replaces the conversation.

`saveWorkspace()` waits for pending connection and restore work, then returns the whole-element workspace
config (a `layout` tree plus per-panel viewer configs).

For tables in `panel_defaults` or `tables`, `saveWorkspace()` also includes `retained_panel_configs_by_table`, a mapping from table name
to its last panel configuration. `savePortableWorkspace()` is an alias kept for existing callers. The result can
be assigned to `config.workspace`. Storage and downloads remain application-owned.

`openTablePanel(name)` accepts names from `config.panel_defaults` or `config.tables` (string and object entries).
It opens the table using its retained configuration, then defaults from `config.panel_defaults`, or Datagrid
when no panel defaults exist. Declaring a table does not create it; it must be available from the
connected client. If already open, the first matching panel is selected, including a master panel. New panels join the
first detail tab stack; with `restore_selected_tabs_only=True`, they replace that stack's selected tab. Master
stacks remain in place. `closeTablePanels(name)` closes panels for that table and retains their last
configuration, including when closing the final panel. Both methods return promises and share the
wrapper's lifecycle queue. Undeclared names and calls without a loaded client reject. Calls queued behind an initial load wait
for that load to finish.

Tables are identified by table name, with one retained configuration per table. Applications with
multiple independent views of one table can continue using ordinary workspace panels; closing table panels
acts on all views of its table. Native tab-close actions also retain the last edited configuration.

`showTable(name, options={})` selects the first existing non-master panel for the table, or
creates a detail panel from `config.panel_defaults[name]` (Datagrid for declared tables without defaults).
It preserves other panel instances, configuration, and existing split proportions. New panels join
the first detail tab stack; if none exists, a new detail stack is added beside the existing layout.
This operation retains other tabs even with `restore_selected_tabs_only=True`.

`options.filter` accepts Perspective filter clauses. Clauses on the supplied columns replace all
existing clauses on those columns; filters on other columns remain. Omitting `filter` or passing an
empty list leaves filters unchanged. Use `restorePanel(id, {"filter": []})` to clear every filter.
Arguments are snapshotted when called. Selection, creation, and filtering run together on the
lifecycle queue; the returned promise resolves to the selected panel ID after rendering. Unknown
tables, malformed options, and upstream restore failures reject without
blocking later queued operations.

`restorePanel(id, config)` applies a partial viewer configuration to an existing panel through the
same lifecycle queue. `id` is a key in `saveWorkspace().panels`, not a table name. Unspecified settings and
other panels remain unchanged. The method snapshots its arguments when called and validates against
the panel's effective plugin. It returns a promise
that rejects for missing panels, invalid configurations, or an upstream restore failure. Later queued
operations can still run after a rejection. Panel existence is checked when the operation executes.

```python
from spaday import Invoke, by_id, element

element("button").text("Open trades").on(
    "click", Invoke(by_id("workspace"), "openTablePanel", "trades")
)
element("button").text("Buy trades").on(
    "click",
    Invoke(by_id("workspace"), "showTable", "trades", {"filter": [["side", "==", "Buy"]]}, result="shown"),
)
```

This example selects a detail panel for `trades` and stores its ID in `shown`. The runnable market
example uses the returned ID to export rows without inspecting the workspace layout.

`viewer` returns the underlying `<perspective-viewer>` element — the escape hatch for its
imperative and query API (`getTable`, `getSelection`, `download`, `copy`, `addPanel`/`removePanel`,
`setActivePanel`, the agent methods, ...), typically from a `NamedJs` handler.

## `THEMES`

Perspective themes itself by name; `spaday_perspective.THEMES` maps page modes to those names:
`{"light": "Pro Light", "dark": "Pro Dark"}`, the Perspective theme a panel applies for each page
mode. A panel with no `theme` follows the nearest `wa-dark` / `wa-light` ancestor to one of these.
`theme` and `themes` accept the keys as shorthands and pass any other name to Perspective unchanged,
so a theme an application registers is selected by its name.

## `package`

`spaday_perspective.package` is named `perspective`. Its browser asset defines `<perspective-panel>`
and the Perspective themes, and loads Perspective's own client, viewer, datagrid and charts modules,
which the package serves under `vendor/` beside their WASM binaries. Its `components` collection
contains `PerspectiveViewer`; `catalog` returns the wrapper's property, event, and slot schema.

`package.imports` publishes those modules under Perspective's bare specifiers, which spaday emits as
the page's import map:

| Specifier                          | Served from                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `@perspective-dev/client`          | `vendor/@perspective-dev/client/dist/cdn/perspective.js`                          |
| `@perspective-dev/viewer`          | `vendor/@perspective-dev/viewer/dist/cdn/perspective-viewer.js`                   |
| `@perspective-dev/viewer-charts`   | `vendor/@perspective-dev/viewer-charts/dist/cdn/perspective-viewer-charts.js`     |
| `@perspective-dev/viewer-datagrid` | `vendor/@perspective-dev/viewer-datagrid/dist/cdn/perspective-viewer-datagrid.js` |

Any other module on the page that imports them gets the same copy.

## Restoring saved workspaces

Config updates skip superseded work that has not started. An already-running upstream restore
finishes before the newest config applies. Imperative methods remain queued in order.

Saved workspaces with the same panel IDs, tables, plugins, and style settings reuse existing plugins,
including inactive tabs. Only panels whose view configuration changed are restored; unchanged panels
receive no per-panel restore. Comparison uses live state, so restoring a saved workspace resets user edits.

Reuse requires complete saved configurations and unchanged derived tables. Incomplete configurations,
added or removed panels, and table/plugin/style changes use a full restore.
Perspective merges plugin and column styles during per-panel updates; full restoration preserves the
replacement semantics of saved workspaces in those cases.

`js/tests/workspace-restores.spec.js` measures layout-only changes on 48 panels and changed saved
workspaces on 48 Datagrid panels over 100,000 synthetic trade rows. The larger fixture has four visible
stacks, inactive tabs, grouping, sorting, and filters. It compares a full restore with changes to four
existing panels and checks that the saved results match. Timing, long tasks, restore calls, and
retained plugin counts are attached to the Playwright report without machine-dependent thresholds.
This local-worker fixture does not measure remote-table latency or expensive chart configurations.
Initial loads and structural changes still include upstream panel construction and rendering costs.
