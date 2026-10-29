# API reference

## `PerspectivePanel`

Tag: `<perspective-panel>`.

| Prop        | Type        | Description                                                                       |
| ----------- | ----------- | --------------------------------------------------------------------------------- |
| `config`    | mapping     | Connection, table names, and workspace layout.                                    |
| `theme`     | `str`       | `light`, `dark`, or a Perspective theme name.                                     |
| `themes`    | `list[str]` | Theme names offered by the status-bar picker (same shorthands accepted).          |
| `autosize`  | `bool`      | Auto-size mode (on by default).                                                   |
| `autopause` | `bool`      | Pause rendering while not visible (on by default).                                |
| `throttle`  | `int`       | Render throttle in milliseconds; unset restores adaptive throttling.              |
| `settings`  | `bool`      | Whether the settings sidebar is open.                                             |
| `toolbar`   | `bool`      | Show channel controls and Copy selection (default `False`).                       |
| `hide_tabs` | `bool`      | Hide internal viewer tab strips and reclaim their space (default `False`).        |
| `find`      | `bool`      | Enable focused-grid Ctrl+F / Cmd+F and the toolbar Find button (default `False`). |

```{eval-rst}
.. autoclass:: spaday_perspective.PerspectivePanel
   :members:
```

## Configuration

`hide_tabs` hides every internal tab strip without changing the saved workspace or its panels.
It does not hide the wrapper toolbar. For multiple channels, provide navigation through the toolbar
or your own buttons calling `openChannel`; hidden tabs cannot be selected or dragged by the user.
The browser property is `hideTabs`.

| Key                    | Type    | Description                                                                                                                                                                                                             |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws_url`               | `str`   | Perspective websocket URL; relative URLs use the current host.                                                                                                                                                          |
| `local`                | `bool`  | Load the shared in-browser Perspective worker instead of opening a websocket.                                                                                                                                           |
| `tables`               | `list`  | Table names (`str`), or `{name, architecture, index, limit}` mappings for per-table architecture.                                                                                                                       |
| `default_architecture` | `str`   | `server` (default) or `client-server`, applied to `tables` entries without their own `architecture`.                                                                                                                    |
| `layout`               | mapping | Workspace config accepted by `<perspective-viewer>.restoreWorkspace()`, plus optional `closed_channels`.                                                                                                                |
| `wait_for_table`       | `bool`  | Leave a panel whose `table` no loaded client hosts yet empty and pending until it is created, instead of erroring (the default).                                                                                        |
| `master_theme`         | `str`   | Theme for filter-source panels listed in `masters`. Accepts `light`, `dark`, or a registered theme name. Defaults to the application theme.                                                                             |
| `channels`             | mapping | Table name to default panel configuration, such as `{"trades": {"title": "Trades", "columns": ["price"]}}`. Supplies the channel picker and default configs; declared tables also support `openChannel`/`closeChannel`. |
| `single_tab`           | `bool`  | Keep only the selected tab in each stack before restoring it. Hidden configured channels retain their settings for reopening. Default `False`.                                                                          |

Changing `ws_url` opens a new client connection. Changing the serialized `layout` restores the viewer's panels.
The wrapper queues asynchronous changes in assignment order.

For a `client-server` mirror, omitting both `index` and `limit` inherits the source table's index.
An explicit index or limit takes precedence; unindexed sources remain unindexed.

### Validation and enums

The public `spaday_perspective.PerspectivePanel` validates literal configuration when serialized
with `to_node()` (including through `serve()` or a widget). This includes `.prop("config", ...)`
updates. `validate_config(config)` performs the same check explicitly and raises `ValueError`
with a path such as `config.layout.panels.trades.plugin_config.edit_mode`. Browser property setters
validate reactive config updates before accepting them. Computed expressions are checked when
their result reaches the browser, not while authoring the expression.

Validation covers wrapper flags, table descriptors, panel/channel mappings, theme-name types, and
the pinned Datagrid's plugin settings. Unknown Datagrid settings are rejected. Custom plugins,
per-column style payloads, and table-dependent filter/expression validity remain upstream-owned.
Unknown wrapper/workspace extension fields are preserved. This is not a complete validator for
every Perspective plugin or layout tree.

The shared Datagrid contract is checked against the installed plugin's live settings schema and
TypeScript enum declarations. An upstream field, type, or enum change fails those tests. Positive
finite font sizes and row heights are accepted, including values outside the settings UI's slider
ranges; `zebra_rows` accepts nonnegative finite numbers, which Perspective rounds down.

Python string enums are exported for configuration:

- `EditMode`: `EDIT`, `READ_ONLY`, `SELECT_ROW`, `SELECT_COLUMN`, `SELECT_REGION`, `SELECT_ROW_TREE`.
- `Alignment`: `TOP_LEFT`, `TOP`, `TOP_RIGHT`, `LEFT`, `CENTER`, `RIGHT`, `BOTTOM_LEFT`, `BOTTOM`, `BOTTOM_RIGHT`.
- `Theme`: `LIGHT`, `DARK`, `PRO_LIGHT`, `PRO_DARK`.

Enum members serialize to Perspective's string values. Plain strings remain accepted. Theme names
must be nonempty strings; application-defined names remain valid. The scroll setting is
`plugin_config.scroll_lock`, a boolean, not an enum.

Perspective 4 workspace envelopes (`viewers`, `detail`, `master`) are migrated before restoration.
Migration preserves panel configuration, selected tabs, master panels, and split proportions. Missing
or empty split sizes use equal shares; a missing master/detail split uses 25/75. Version 5 layouts are
unchanged by migration.

`spaday_perspective.migrate_layout(layout)` accepts a mapping or JSON string and returns the same
representation without modifying the input. Existing v5 layouts and invalid JSON strings pass
through unchanged. The browser bundle exports the mapping-only equivalent, `migrateLayout(layout)`.

The application theme overrides saved panel themes before restoration. `master_theme` overrides
that choice for filter-source panels, including during live application theme changes. Input layouts
are copied before preparation. Restoring a saved layout does not require a second theme restore.

Changing `master_theme` or `single_tab` with an unchanged layout applies to the current workspace,
preserving user edits. Turning `single_tab` off permits additional tabs; it does not reopen closed
channels. Replacing `layout` starts a new workspace and replaces its retained channel configurations.

`local=True` expects named tables to be created through `globalThis.__spadayPerspective.worker()` before the panel loads. It is intended for browser-only hosts such as the bundled Pyodide example; normal Python deployments should keep bulk data on Perspective's websocket.

## Table architectures

A `server` table (the default) reads over the websocket: every scroll, sort, and filter round-trips
to the Python server. A `client-server` table mirrors into a local Web Worker engine: the wrapper
opens the server table and replaces a local copy (with the entry's `index` / `limit`) from an Arrow
snapshot after source changes, loading the worker client before the websocket client so the
local copy wins the viewer's table-name lookup. Reads are then local; the server stays authoritative
for writes. Set architectures in the initial `config` — changing the mirrored set later reconnects.

Row deltas omit deleted keys. Snapshot replacement propagates removals, clear, and replace operations
and avoids duplicate appends for unindexed mirrors. Refreshes are serialized and notifications during
an in-flight refresh coalesce into another snapshot. This sends the full source table on refresh;
server architecture avoids that cost for large or frequently changing tables.

## Row actions

`row_actions` (JavaScript `rowActions`) maps table names to indexed-column button descriptions:

```python
PerspectivePanel(row_actions={"orders": {"id": {"action": "delete", "label": "Delete order", "text": "×"}}})
```

A column accepts one description or a list, rendered in order in the same cell:

```python
PerspectivePanel(row_actions={"orders": {"id": [
    {"action": "delete", "label": "Delete order"},
    {"action": "copy", "label": "Copy order to form", "text": "⧉"},
]}})
```

Dedicated columns use identifiers starting with `@` and do not replace the real index column:

```python
PerspectivePanel(row_actions={"orders": {
    "@copy": {
        "header": "Copy", "position": "start",
        "buttons": [{"action": "copy", "label": "Copy order", "icon": "copy"}],
    },
    "@delete": {
        "header": "Delete", "position": "end",
        "buttons": [{"action": "delete", "label": "Delete order", "icon": "delete"}],
    },
}})
```

Any number of dedicated columns may appear at either end, in mapping insertion order within
each position. Each accepts multiple buttons. Headers must be unique and must not collide with
source columns or user expressions. An empty button list removes the generated column.
View-level expressions provide the record keys; source tables are unchanged. The wrapper's
`save()` and `saveClean()` omit those expressions and columns, which are recreated from
`row_actions` on restoration. Direct calls to `viewer.saveWorkspace()` include them and are not
portable to a fresh wrapper with the same action policy; use wrapper `save()` or `saveClean()`
for persistence. Matching expression text alone does not establish wrapper ownership.
Replace a panel's table through `config.layout`. Partial table swaps through the raw viewer API
can retain the old table's expressions, including generated action fields; the wrapper does not
assume ownership of expressions on a different table.
In dedicated-column events, `column` is the stable `@` identifier, not its display header.

An empty list removes an indexed column's buttons. The market example uses a leading copy
column and a trailing delete column. Copy fills the existing order form without inserting a row.
Delete opens a dialog authored in Python; Cancel and Escape leave the table unchanged, and
confirmation calls the Python deletion endpoint. Its summary totals
cover all retained trades, including rows hidden by filters, and update when rows are deleted or expire.

`action` and accessible `label` are nonempty strings. `icon` accepts `copy`, `delete` (an X),
or `add`. Icons are built-in SVGs, use the button's color, and are hidden from assistive technology;
`label` supplies the accessible name. `text` may accompany an icon. Without an icon, it defaults to `×`.
Labels and text are rendered as text, never HTML. Annotations apply to all Datagrid panels for that
table and are separate from Perspective's saved layout and column configuration.

Literal `row_actions` values are validated by Python at serialization, including `.prop("rowActions", ...)`.
`validate_row_actions(value)` performs the same check explicitly. Computed values are validated in
the browser. Header collisions with live table columns or expressions are checked in the browser;
one failing panel emits `perspective-error` without preventing other panels or workspace saves.
Repeated identical errors are reported once until recovery. Initial `perspective-ready` waits for
action configuration to succeed. Removing or correcting the conflicting policy recovers it.
User-edited expressions are preserved, even when their name previously belonged to an action column.

Removing generated columns also removes their grouping, splitting, sort, filter, aggregate and
style references. Saved layouts omit those references with the generated columns.

Indexed-column buttons replace the displayed index value without changing data. Only flat, unsplit views with a
string or safe-integer key are enabled. Grouped views, non-index columns, and missing/unsupported
keys disable the button. Other plugins do not display dedicated columns.

`rowActions` supports computed bindings, including nested labels:

```python
PerspectivePanel().compute("rowActions", obj({"orders": obj({"id": obj({
    "action": "copy", "label": field("copy_label"), "icon": "copy",
})})}))
```

Here `obj` and `field` are imported from `spaday`. Updating the store's `copy_label` updates
button labels without recreating the panel or mutating its data.

Pointer or keyboard activation emits bubbling, composed `perspective-row-action` with
`{action, panel, table, column, key}`. `key` retains its string/number type; `panel` is the current
Perspective panel ID. Buttons do not select/edit cells or mutate data. The application owns
authorization, confirmation, deletion, and error presentation. No optimistic removal occurs.

The adapter uses the pinned Datagrid's `regular_table` style listeners and rendered cell metadata,
not asynchronous row-position lookup. A pointer gesture is cancelled if its button/identity changes
before click. Listeners and rendered buttons are removed when annotations or the wrapper are removed.

Button colors inherit the active theme and accept `--spa-perspective-action-color`,
`--spa-perspective-action-background`, and `--spa-perspective-action-border` overrides.

## Events

Perspective's viewer events do not bubble, so the panel re-dispatches the observational set as
bubbling DOM events usable from spaday's `.on(...)`: `perspective-click`, `perspective-select`,
`perspective-global-filter`, `perspective-global-filter-update`, `perspective-config-update`,
`perspective-toggle-settings`, `perspective-statusbar-pointerdown`, and `perspective-table-delete`.
`perspective-config-update` fires on user edits (layout drags, view changes, filters) — bind it to
persist user-edited workspaces. Two panel-level lifecycle events complete the picture:
`perspective-ready` fires once, after the panel has connected, loaded its tables, and applied and
rendered its initial workspace config — the signal to dismiss a branded startup overlay — and
`perspective-error` fires when a config apply fails (connection, mirror, or restore), with the error
in `detail`, so a host can swap its loader for an error state. The cancelable `*-before` events are not re-dispatched; attach to
the viewer directly for those.

## Methods

`exportData({panel?, format?})` returns CSV text by default or JSON text with `format: "json"`.
`panel` defaults to the active panel. It exports the configured view, excluding synthetic action
value columns, and retains filtering, sorting, grouping, splitting and expressions. Group keys
remain present, including when a generated expression is used as a grouping key. This exports
the whole configured view rather than the selected block or viewport. The temporary export view
is deleted on success and failure; the displayed view is not changed.

Native Perspective export and selected-cell copying retain their original view-based behavior:
selected/exported action fields contain record IDs. `exportData` provides the separate data-only
path used by the example's **Export CSV** button.

`openFind()` opens the column/value prompt for the active panel when `find=True`. With the toolbar
enabled, Find invokes this method. Ctrl+F / Cmd+F instead targets the Datagrid receiving the key event.
Other page content, editable inputs, and wrappers with Find disabled keep browser find behavior.

Find lists source-table columns and uses `==`, converting the entered value to the column's type.
Dates use UTC midnight; datetime input uses browser-local time. Computed columns and null-value
search are not offered. A selected column is preselected when its position maps unambiguously to
the source schema. Applying adds a filter without replacing existing filters or adding an identical
duplicate. Configurations reporting OR-combined filters are refused instead of changing their meaning.
Zero matches leave an empty filtered view. Filters can be edited or removed in Perspective Settings.

Find reads schema metadata and applies the filter through Perspective's public API; it does not
export or search rows in the browser. Filtering may still scan data in the engine. Cancellation,
disabling Find, or disconnecting closes the prompt; it does not undo a filter already submitted.

`copySelection()` copies the last focused grid's selection using Perspective's plugin text export.
It must be called directly from a user gesture and resolves `true` on success, `false` for no selection,
cancellation, or failure. Ctrl+C, Cmd+C, and the optional toolbar's Copy selection button use this path.
Inputs, editable content, and ordinary browser text selections retain native copying.

The secure Clipboard API is invoked before asynchronous export completes. When unavailable or denied,
a text-only copy-event fallback is attempted while user activation remains valid. Failure emits
`perspective-copy-error` with `{message, error}`; the application owns notifications. Pending exports
are cancelled by selection/config changes, focus changes, new gestures, or disconnects. A write already
accepted by the operating system cannot be revoked.

Perspective 5.5's native Copy menu uses its own clipboard implementation. On insecure HTTP pages,
the adapter blocks that menu's copy action and emits `perspective-copy-error`. Copy selection and
keyboard copying can still use the fallback where browser policy permits it; otherwise Export remains
available. Secure-context native-menu writes are not intercepted by the adapter.

`save()` waits for pending connection and restore work, then returns the whole-element workspace
config (`saveWorkspace()` under the hood — a `layout` tree plus per-panel viewer configs).

For configured channels and declared tables, `save()` also includes `closed_channels`, a mapping from table name
to its last panel configuration. `saveClean()` returns the same shape with themes and datagrid column
size overrides removed from both open and closed channels. Both results can be assigned to
`config.layout`. Storage and downloads remain application-owned.

`openChannel(name)` accepts names from `config.channels` or `config.tables` (string and object entries).
It opens the table using its retained configuration, then defaults from `config.channels`, or Datagrid
when no channel defaults exist. Declaring a table does not create it; it must be available from the
connected client. If already open, the first matching panel is selected. New channels join the
first detail tab stack; with `single_tab=True`, they replace that stack's selected channel. Master
stacks remain in place. `closeChannel(name)` closes panels for that table and retains their last
configuration, including when closing the final panel. Both methods return promises and share the
wrapper's lifecycle queue. Undeclared names and calls without a loaded client reject. Calls queued behind an initial load wait
for that load to finish.

Channels are identified by table name, with one retained configuration per table. Applications with
multiple independent views of one table can continue using ordinary workspace panels; channel close
acts on all views of its table. Native tab-close actions also retain the last edited configuration.

`restorePanel(id, config)` applies a partial viewer configuration to an existing panel through the
same lifecycle queue. `id` is a key in `save().panels`, not a table name. Unspecified settings and
other panels remain unchanged. The method snapshots its arguments when called, validates against the
panel's effective plugin, and refreshes synthetic action columns after restoring. It returns a promise
that rejects for missing panels, invalid configurations, or an upstream restore failure. Later queued
operations can still run after a rejection. Panel existence is checked when the operation executes.

```python
from spaday import Invoke, by_id, element

element("button").text("Open trades").on(
    "click", Invoke(by_id("workspace"), "openChannel", "trades")
)
element("button").text("Buy trades").on(
    "click",
    Invoke(by_id("workspace"), "restorePanel", "market", {"filter": [["side", "==", "Buy"]]}),
)
```

This example targets a panel declared as `market` in `config.layout.panels`. The runnable market
example also handles reopening a closed channel by reading its panel ID from the saved layout.

The optional toolbar lists only entries in `config.channels` and uses these same methods. Its container has class `perspective-panel-titlebar`
and inherits `--spa-text` and `--spa-surface`. Custom design-kit controls can call the methods through
Spaday `Invoke` without enabling the toolbar or accessing the viewer's shadow DOM.

`viewer` returns the underlying `<perspective-viewer>` element — the escape hatch for its
imperative and query API (`getTable`, `getSelection`, `download`, `copy`, `addPanel`/`removePanel`,
`setActivePanel`, the agent methods, ...), typically from a `NamedJs` handler.

## `THEMES` and `TOKENS`

`spaday_perspective.TOKENS` lists `spa_perspective_action_color`, `spa_perspective_action_background`,
and `spa_perspective_action_border` for the optional row buttons. Pass these keywords to `.css()`
to set the corresponding `--spa-perspective-*` properties. These do not replace Perspective's grid themes.
Perspective themes itself by name; `spaday_perspective.THEMES` maps page modes to those names:
`{"light": "Pro Light", "dark": "Pro Dark"}`, the Perspective theme a panel applies for each page
mode. A panel with no `theme` follows the nearest `wa-dark` / `wa-light` ancestor to one of these.
`theme` and `themes` accept the keys as shorthands and pass any other name to Perspective unchanged,
so a theme an application registers is selected by its name.

## `package`

`spaday_perspective.package` is named `perspective`. Its browser asset defines `<perspective-panel>`
and the Perspective themes, and loads Perspective's own client, viewer, datagrid and charts modules,
which the package serves under `vendor/` beside their WASM binaries. Its `components` collection
contains `PerspectivePanel`; `catalog` returns the wrapper's property, event, and slot schema.

`package.imports` publishes those modules under Perspective's bare specifiers, which spaday emits as
the page's import map:

| Specifier                          | Served from                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `@perspective-dev/client`          | `vendor/@perspective-dev/client/dist/cdn/perspective.js`                          |
| `@perspective-dev/viewer`          | `vendor/@perspective-dev/viewer/dist/cdn/perspective-viewer.js`                   |
| `@perspective-dev/viewer-charts`   | `vendor/@perspective-dev/viewer-charts/dist/cdn/perspective-viewer-charts.js`     |
| `@perspective-dev/viewer-datagrid` | `vendor/@perspective-dev/viewer-datagrid/dist/cdn/perspective-viewer-datagrid.js` |

Any other module on the page that imports them gets the same copy.
