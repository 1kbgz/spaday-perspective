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

```{eval-rst}
.. autoclass:: spaday_perspective.PerspectivePanel
   :members:
```

## Configuration

| Key      | Type        | Description                                                                                               |
| -------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `ws_url` | `str`       | Perspective websocket URL; relative URLs use the current host.                                            |
| `tables` | `list[str]` | Informational list of table names available on the server.                                                |
| `layout` | mapping     | Value accepted by `<perspective-viewer>.restore()` — the whole-element config (`layout` tree + `panels`). |

Changing `ws_url` opens a new client connection. Changing the serialized `layout` restores the viewer's panels.
The wrapper queues asynchronous changes in assignment order.

## Events

Perspective's viewer events do not bubble, so the panel re-dispatches the observational set as
bubbling DOM events usable from spaday's `.on(...)`: `perspective-click`, `perspective-select`,
`perspective-global-filter`, `perspective-global-filter-update`, `perspective-config-update`,
`perspective-toggle-settings`, `perspective-statusbar-pointerdown`, and `perspective-table-delete`.
`perspective-config-update` fires on user edits (layout drags, view changes, filters) — bind it to
persist user-edited workspaces. The cancelable `*-before` events are not re-dispatched; attach to
the viewer directly for those.

## Methods

`save()` waits for pending connection and restore work, then returns the whole-element workspace
config (`saveWorkspace()` under the hood — a `layout` tree plus per-panel viewer configs).

`viewer` returns the underlying `<perspective-viewer>` element — the escape hatch for its
imperative and query API (`getTable`, `getSelection`, `download`, `copy`, `addPanel`/`removePanel`,
`setActivePanel`, the agent methods, ...), typically from a `NamedJs` handler.

## `package`

`spaday_perspective.package` is named `perspective`. Its self-contained browser asset includes the
Perspective client, viewer, workspace, datagrid plugin, themes, and viewer WASM. Its `components`
collection contains `PerspectivePanel`; `catalog` returns the wrapper's property, event, and slot schema.
