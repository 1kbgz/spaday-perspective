# API reference

## `PerspectivePanel`

Tag: `<perspective-panel>`.

| Prop        | Type        | Description                                                              |
| ----------- | ----------- | ------------------------------------------------------------------------ |
| `config`    | mapping     | Connection, table names, and workspace layout.                           |
| `theme`     | `str`       | `light`, `dark`, or a Perspective theme name.                            |
| `themes`    | `list[str]` | Theme names offered by the status-bar picker (same shorthands accepted). |
| `autosize`  | `bool`      | Auto-size mode (on by default).                                          |
| `autopause` | `bool`      | Pause rendering while not visible (on by default).                       |
| `throttle`  | `int`       | Render throttle in milliseconds; unset restores adaptive throttling.     |
| `settings`  | `bool`      | Whether the settings sidebar is open.                                    |
| `toolbar`   | `bool`      | Show the channel picker and close button (default `False`).              |

```{eval-rst}
.. autoclass:: spaday_perspective.PerspectivePanel
   :members:
```

## Configuration

| Key                    | Type    | Description                                                                                                                                                               |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws_url`               | `str`   | Perspective websocket URL; relative URLs use the current host.                                                                                                            |
| `local`                | `bool`  | Load the shared in-browser Perspective worker instead of opening a websocket.                                                                                             |
| `tables`               | `list`  | Table names (`str`), or `{name, architecture, index, limit}` mappings for per-table architecture.                                                                         |
| `default_architecture` | `str`   | `server` (default) or `client-server`, applied to `tables` entries without their own `architecture`.                                                                      |
| `layout`               | mapping | Workspace config accepted by `<perspective-viewer>.restoreWorkspace()`, plus optional `closed_channels`.                                                                  |
| `wait_for_table`       | `bool`  | Leave a panel whose `table` no loaded client hosts yet empty and pending until it is created, instead of erroring (the default).                                          |
| `master_theme`         | `str`   | Theme for filter-source panels listed in `masters`. Accepts `light`, `dark`, or a registered theme name. Defaults to the application theme.                               |
| `channels`             | mapping | Table name to default panel configuration, such as `{"trades": {"title": "Trades", "columns": ["price"]}}`. Supplies the channel picker and `openChannel`/`closeChannel`. |
| `single_tab`           | `bool`  | Keep only the selected tab in each stack before restoring it. Hidden configured channels retain their settings for reopening. Default `False`.                            |

Changing `ws_url` opens a new client connection. Changing the serialized `layout` restores the viewer's panels.
The wrapper queues asynchronous changes in assignment order.

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
opens the server table, seeds a local copy (with the entry's `index` / `limit`) from an arrow
snapshot, and feeds row deltas forward, loading the worker client before the websocket client so the
local copy wins the viewer's table-name lookup. Reads are then local; the server stays authoritative
for writes. Set architectures in the initial `config` — changing the mirrored set later reconnects.

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

`save()` waits for pending connection and restore work, then returns the whole-element workspace
config (`saveWorkspace()` under the hood — a `layout` tree plus per-panel viewer configs).

When channels are configured, `save()` also includes `closed_channels`, a mapping from table name
to its last panel configuration. `saveClean()` returns the same shape with themes and datagrid column
size overrides removed from both open and closed channels. Both results can be assigned to
`config.layout`. Storage and downloads remain application-owned.

`openChannel(name)` opens a configured table, using its retained configuration or its defaults from
`config.channels`. If already open, the first matching panel is selected. New channels join the
first detail tab stack; with `single_tab=True`, they replace that stack's selected channel. Master
stacks remain in place. `closeChannel(name)` closes panels for that table and retains their last
configuration, including when closing the final panel. Both methods return promises and share the
wrapper's lifecycle queue. Unknown channel names and calls before connection completes reject.

Channels are identified by table name, with one retained configuration per table. Applications with
multiple independent views of one table can continue using ordinary workspace panels; channel close
acts on all views of its table. Native tab-close actions also retain the last edited configuration.

The optional toolbar uses these same methods. Its container has class `perspective-panel-titlebar`
and inherits `--spa-text` and `--spa-surface`. Custom design-kit controls can call the methods through
Spaday `Invoke` without enabling the toolbar or accessing the viewer's shadow DOM.

`viewer` returns the underlying `<perspective-viewer>` element — the escape hatch for its
imperative and query API (`getTable`, `getSelection`, `download`, `copy`, `addPanel`/`removePanel`,
`setActivePanel`, the agent methods, ...), typically from a `NamedJs` handler.

## `THEMES` and `TOKENS`

Perspective themes itself by name rather than by CSS custom property, so `spaday_perspective.TOKENS`
is empty and `spaday_perspective.THEMES` carries the contract instead:
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
