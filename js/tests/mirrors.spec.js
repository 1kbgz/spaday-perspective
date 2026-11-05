import { expect, test } from "@playwright/test";

// Every mirror is a `table(view)` replica. The entry's `index` / `limit` are the copy's own options,
// the server table's index or limit inherited when they are omitted; only a limit on an indexed
// server table cannot apply, and warns.
for (const [mode, index, limit, warns] of [
  ["inferred", "id", undefined, 0],
  ["explicit", "alternate", undefined, 0],
  ["limited", "id", undefined, 1],
  ["unindexed", undefined, 7, 0],
  ["unindexed-explicit", "alternate", undefined, 0],
  ["unindexed-limited", undefined, 3, 0],
  ["composite", ["id", "alternate"], undefined, 0],
]) {
  test(`mirror index configuration: ${mode}`, async ({ page }) => {
    const warnings = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.goto("http://127.0.0.1:8016");
    const result = await page.evaluate(async (mode) => {
      const engine = globalThis.__spadayPerspective;
      const remote = await engine.client("/perspective");
      const name = `index-${crypto.randomUUID()}`;
      const source = await remote.table([{ id: 1, alternate: "one" }], {
        name,
        ...(mode.startsWith("unindexed")
          ? { limit: 7 }
          : { index: mode === "composite" ? ["id", "alternate"] : "id" }),
      });
      const panel = document.createElement("perspective-panel");
      panel.config = {
        ws_url: "/perspective",
        tables: [
          {
            name,
            architecture: "client-server",
            ...(mode.endsWith("explicit")
              ? { index: "alternate" }
              : mode === "limited"
                ? { limit: 10 }
                : mode === "unindexed-limited"
                  ? { limit: 3 }
                  : {}),
          },
        ],
      };
      document.body.append(panel);
      await panel.save();
      const table = await (await engine.worker()).open_table(name);
      const result = {
        index: await table.get_index(),
        limit: await table.get_limit(),
      };
      panel.config = { ...panel.config, tables: [] };
      await panel.save();
      panel.remove();
      await source.delete({ lazy: true });
      return result;
    }, mode);
    expect(result).toEqual({ index, limit });
    expect(warnings.filter((text) => text.includes("is ignored"))).toHaveLength(
      warns,
    );
  });
}

test("a mirror becomes ready while source updates continue", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8016");
  await page.evaluate(async () => {
    const engine = globalThis.__spadayPerspective;
    const remote = await engine.client("/perspective");
    const name = `streaming-mirror-${crypto.randomUUID()}`;
    const source = await remote.table([{ id: 1, value: 0 }], {
      name,
      index: "id",
    });
    const originalOpen = remote.open_table.bind(remote);
    remote.open_table = async (requested) => {
      const table = await originalOpen(requested);
      if (requested === name) {
        const originalView = table.view.bind(table);
        table.view = async (...args) => {
          const view = await originalView(...args);
          const originalArrow = view.to_arrow.bind(view);
          view.to_arrow = async (...options) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return originalArrow(...options);
          };
          return view;
        };
      }
      return table;
    };
    let stopped = false;
    let value = 0;
    const updates = (async () => {
      while (!stopped) {
        await source.update([{ id: 1, value: ++value }]);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "height:240px;width:600px";
    panel.config = {
      ws_url: "/perspective",
      tables: [{ name, architecture: "client-server", index: "id" }],
      layout: {
        layout: { type: "tab-layout", tabs: ["rows"] },
        panels: { rows: { table: name, plugin: "Datagrid" } },
      },
    };
    window.streamingMirror = {
      ready: false,
      errors: [],
      async cleanup() {
        stopped = true;
        await updates;
        remote.open_table = originalOpen;
        panel.config = { ...panel.config, tables: [] };
        await panel.save();
        panel.remove();
        await source.delete({ lazy: true });
      },
    };
    panel.addEventListener("perspective-ready", () => {
      window.streamingMirror.ready = true;
    });
    panel.addEventListener("perspective-error", (event) => {
      window.streamingMirror.errors.push(String(event.detail));
    });
    document.body.append(panel);
  });
  try {
    await expect
      .poll(() => page.evaluate(() => window.streamingMirror.ready))
      .toBe(true);
    expect(await page.evaluate(() => window.streamingMirror.errors)).toEqual(
      [],
    );
  } finally {
    await page.evaluate(() => window.streamingMirror.cleanup());
  }
});

for (const indexed of [true, false]) {
  test(`mirrors removals, replacement, and clear (indexed=${indexed})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("http://127.0.0.1:8016");
    await page.evaluate(async (indexed) => {
      const engine = globalThis.__spadayPerspective;
      const remote = await engine.client("/perspective");
      const name = `mirror-${crypto.randomUUID()}`;
      const source = await remote.table(
        [
          { id: 1, value: "one" },
          { id: 2, value: "two" },
        ],
        {
          name,
          ...(indexed ? { index: "id" } : {}),
        },
      );
      const panel = document.createElement("perspective-panel");
      panel.style.cssText = "height:240px;width:600px";
      panel.config = {
        ws_url: "/perspective",
        tables: [
          {
            name,
            architecture: "client-server",
            ...(indexed ? { index: "id" } : {}),
          },
        ],
        layout: {
          layout: { type: "tab-layout", tabs: ["rows"] },
          panels: { rows: { table: name, plugin: "Datagrid" } },
        },
      };
      const ready = new Promise((resolve, reject) => {
        panel.addEventListener("perspective-ready", resolve, { once: true });
        panel.addEventListener("perspective-error", reject, { once: true });
      });
      document.body.append(panel);
      await ready;
      const local = await (await engine.worker()).open_table(name);
      const view = await local.view({ sort: [["id", "asc"]] });
      window.mirrorTest = { source, view, panel };
    }, indexed);
    const rows = () => page.evaluate(() => window.mirrorTest.view.to_json());
    await expect.poll(rows).toEqual([
      { id: 1, value: "one" },
      { id: 2, value: "two" },
    ]);
    if (indexed) {
      await page.evaluate(() => window.mirrorTest.source.remove([1]));
      await expect.poll(rows).toEqual([{ id: 2, value: "two" }]);
    }
    await page.evaluate(() =>
      window.mirrorTest.source.replace([{ id: 3, value: "three" }]),
    );
    await expect.poll(rows).toEqual([{ id: 3, value: "three" }]);
    await page.evaluate(() => window.mirrorTest.source.clear());
    await expect.poll(rows).toEqual([]);
    await page.evaluate(async () => {
      const { source } = window.mirrorTest;
      for (let id = 4; id < 14; id++)
        await source.update([{ id, value: String(id) }]);
    });
    await expect.poll(rows).toEqual(
      Array.from({ length: 10 }, (_, i) => ({
        id: i + 4,
        value: String(i + 4),
      })),
    );
    await page.evaluate(async () => {
      const { source, view, panel } = window.mirrorTest;
      await view.delete();
      panel.config = { ...panel.config, tables: [] };
      await panel.save();
      panel.remove();
      await source.delete({ lazy: true });
    });
  });
}

test("mirrors a composite-index table through updates, removal, replace and clear", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:8016");
  await page.evaluate(async () => {
    const engine = globalThis.__spadayPerspective;
    const remote = await engine.client("/perspective");
    const name = `composite-${crypto.randomUUID()}`;
    const source = await remote.table(
      [
        { id: 1, group: "a", value: "one" },
        { id: 1, group: "b", value: "two" },
      ],
      { name, index: ["id", "group"] },
    );
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "height:240px;width:600px";
    panel.config = {
      ws_url: "/perspective",
      tables: [{ name, architecture: "client-server" }],
      layout: {
        layout: { type: "tab-layout", tabs: ["rows"] },
        panels: { rows: { table: name, plugin: "Datagrid" } },
      },
    };
    const ready = new Promise((resolve, reject) => {
      panel.addEventListener("perspective-ready", resolve, { once: true });
      panel.addEventListener("perspective-error", reject, { once: true });
    });
    document.body.append(panel);
    await ready;
    const local = await (await engine.worker()).open_table(name);
    const view = await local.view({
      sort: [
        ["id", "asc"],
        ["group", "asc"],
      ],
    });
    window.mirrorTest = { source, local, view, panel };
  });
  const rows = () => page.evaluate(() => window.mirrorTest.view.to_json());
  expect(
    await page.evaluate(() => window.mirrorTest.local.get_index()),
  ).toEqual(["id", "group"]);
  await expect.poll(rows).toEqual([
    { id: 1, group: "a", value: "one" },
    { id: 1, group: "b", value: "two" },
  ]);
  await page.evaluate(() =>
    window.mirrorTest.source.update([
      { id: 1, group: "b", value: "TWO" },
      { id: 2, group: "a", value: "three" },
    ]),
  );
  await expect.poll(rows).toEqual([
    { id: 1, group: "a", value: "one" },
    { id: 1, group: "b", value: "TWO" },
    { id: 2, group: "a", value: "three" },
  ]);
  await page.evaluate(() => window.mirrorTest.source.remove([[1, "a"]]));
  await expect.poll(rows).toEqual([
    { id: 1, group: "b", value: "TWO" },
    { id: 2, group: "a", value: "three" },
  ]);
  await page.evaluate(() =>
    window.mirrorTest.source.replace([{ id: 3, group: "c", value: "four" }]),
  );
  await expect.poll(rows).toEqual([{ id: 3, group: "c", value: "four" }]);
  await page.evaluate(() => window.mirrorTest.source.clear());
  await expect.poll(rows).toEqual([]);
  await page.evaluate(async () => {
    const { source, view, panel } = window.mirrorTest;
    await view.delete();
    panel.config = { ...panel.config, tables: [] };
    await panel.save();
    panel.remove();
    await source.delete({ lazy: true });
  });
  expect(errors).toEqual([]);
});

test("a limited server table mirrors the same rows as the server view", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("http://127.0.0.1:8016");
  await page.evaluate(async () => {
    const engine = globalThis.__spadayPerspective;
    const remote = await engine.client("/perspective");
    const name = `limited-${crypto.randomUUID()}`;
    const source = await remote.table([{ id: 1 }, { id: 2 }], {
      name,
      limit: 3,
    });
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "height:240px;width:600px";
    panel.config = {
      ws_url: "/perspective",
      tables: [{ name, architecture: "client-server" }],
      layout: {
        layout: { type: "tab-layout", tabs: ["rows"] },
        panels: { rows: { table: name, plugin: "Datagrid" } },
      },
    };
    const ready = new Promise((resolve, reject) => {
      panel.addEventListener("perspective-ready", resolve, { once: true });
      panel.addEventListener("perspective-error", reject, { once: true });
    });
    document.body.append(panel);
    await ready;
    const local = await (await engine.worker()).open_table(name);
    window.mirrorTest = {
      source,
      panel,
      server: await source.view({ sort: [["id", "asc"]] }),
      local: await local.view({ sort: [["id", "asc"]] }),
    };
  });
  const rows = (which) =>
    page.evaluate((which) => window.mirrorTest[which].to_json(), which);
  await expect.poll(() => rows("local")).toEqual([{ id: 1 }, { id: 2 }]);
  for (let id = 3; id < 8; id++) {
    await page.evaluate((id) => window.mirrorTest.source.update([{ id }]), id);
    const server = await rows("server");
    expect(server.length).toBeLessThanOrEqual(3);
    await expect.poll(() => rows("local")).toEqual(server);
  }
  await page.evaluate(async () => {
    const { source, server, local, panel } = window.mirrorTest;
    await local.delete();
    await server.delete();
    panel.config = { ...panel.config, tables: [] };
    await panel.save();
    panel.remove();
    await source.delete({ lazy: true });
  });
});
