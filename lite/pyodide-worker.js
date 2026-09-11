const PYODIDE_VERSION = "314.0.4";
let pyodide;

const ready = (async () => {
  self.postMessage({ type: "status", message: "Loading Pyodide…" });
  const { loadPyodide } = await import(
    `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`
  );
  pyodide = await loadPyodide();
  await pyodide.loadPackage(["micropip", "anyio"]);

  self.postMessage({ type: "status", message: "Installing example…" });
  const response = await fetch(new URL("./wheels.json", self.location.href));
  if (!response.ok)
    throw new Error(`wheel manifest returned ${response.status}`);
  const wheels = await response.json();
  const urls = Object.fromEntries(
    Object.entries(wheels).map(([name, path]) => [
      name,
      new URL(path, self.location.href).href,
    ]),
  );
  pyodide.globals.set("wheels_json", JSON.stringify(urls));
  return pyodide.runPythonAsync(`
import asyncio
import json
import micropip

wheels = json.loads(wheels_json)
await micropip.install([
    wheels["spaday"],
    wheels["transports"],
    "starlette",
])
await micropip.install(wheels["perspective"], deps=False)

from spaday_perspective import example

connection = "browser"
server = example.transport_server

def local_wires(messages):
    return list(messages.get(connection, []))

def receive_wire(frame):
    return json.dumps(local_wires(server.recv(connection, frame)))

def flush_updates():
    rows = list(example.browser_updates)
    example.browser_updates.clear()
    return json.dumps({
        "rows": rows,
        "wires": local_wires(server.flush()),
    })

class LocalRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body

async def call_endpoint(body_json):
    response = await example.submit_trade(LocalRequest(json.loads(body_json)))
    updates = json.loads(flush_updates())
    return json.dumps({
        "status": response.status_code,
        "body": json.loads(bytes(response.body).decode()),
        **updates,
    })

opening = server.open(connection, "json")
asyncio.create_task(example.stream_trades())

json.dumps({
    "tree": example.page.to_node(),
    "style": example.styles,
    "store": example.initial_store,
    "rows": example.initial_trades,
    "wires": opening,
})
`);
})();

let queue = Promise.resolve();

async function handle(message) {
  const snapshot = await ready;
  if (message.type === "start") {
    self.postMessage({ type: "snapshot", payload: JSON.parse(snapshot) });
  } else if (message.type === "wire") {
    pyodide.globals.set("wire_frame", message.frame);
    const wires = JSON.parse(pyodide.runPython("receive_wire(wire_frame)"));
    if (wires.length) self.postMessage({ type: "wires", wires });
  } else if (message.type === "flush") {
    const updates = JSON.parse(pyodide.runPython("flush_updates()"));
    if (updates.rows.length || updates.wires.length)
      self.postMessage({ type: "updates", ...updates });
  } else if (message.type === "endpoint") {
    pyodide.globals.set("body_json", JSON.stringify(message.body));
    const result = JSON.parse(
      await pyodide.runPythonAsync("await call_endpoint(body_json)"),
    );
    self.postMessage({ type: "endpoint", id: message.id, ...result });
  }
}

self.addEventListener("message", (event) => {
  queue = queue
    .then(() => handle(event.data))
    .catch((error) => {
      self.postMessage({ type: "error", message: String(error) });
    });
});
