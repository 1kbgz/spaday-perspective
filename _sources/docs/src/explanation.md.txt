# Why Perspective uses its own data channel

Perspective is a columnar analytics engine, not a conventional DOM table. Its websocket protocol moves
table updates into a browser worker and supports views, aggregations, and incremental computation without
serializing the full dataset through the component tree.

`spaday-perspective` therefore separates two kinds of state:

- bulk rows travel through Perspective's native websocket;
- connection URL, theme, and saved workspace layout remain ordinary serializable component properties.

This boundary keeps Python authoring declarative while preserving Perspective's high-performance data
path. A spaday store or transports model can still carry compact application state, such as the selected
layout preset or summary metrics.

Sending every row through spaday would duplicate storage and serialization work before Perspective could
process the same data again. Keeping the native channel also means existing Perspective server code can be
used unchanged. The wrapper only adapts lifecycle, theme, and workspace configuration to spaday.
