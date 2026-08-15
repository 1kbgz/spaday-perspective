# API reference

## `PerspectivePanel`

Tag: `<perspective-panel>`.

| Prop     | Type    | Description                                    |
| -------- | ------- | ---------------------------------------------- |
| `config` | mapping | Connection, table names, and workspace layout. |
| `theme`  | `str`   | `light`, `dark`, or a Perspective theme name.  |

```{eval-rst}
.. autoclass:: spaday_perspective.PerspectivePanel
   :members:
```

## Configuration

| Key      | Type        | Description                                                    |
| -------- | ----------- | -------------------------------------------------------------- |
| `ws_url` | `str`       | Perspective websocket URL; relative URLs use the current host. |
| `tables` | `list[str]` | Informational list of table names available on the server.     |
| `layout` | mapping     | Value accepted by `<perspective-workspace>.restore()`.         |

Changing `ws_url` opens a new client connection. Changing the serialized `layout` restores the workspace.
The wrapper queues asynchronous changes in assignment order.

## Methods

`save()` waits for pending connection and restore work, then returns the workspace's saved layout.

## `package`

`spaday_perspective.package` is named `perspective`. Its self-contained browser asset includes the
Perspective client, viewer, workspace, datagrid plugin, themes, and viewer WASM.
