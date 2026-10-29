import { expect, test } from "@playwright/test";

async function mount(page) {
  await page.goto("/dist/index.html");
  await page.evaluate(async () => {
    const client = await globalThis.__spadayPerspective.worker();
    await client.table(
      [
        { id: "a", value: 10 },
        { id: "b", value: 20 },
      ],
      { name: "rows", index: "id" },
    );
    await client.table([{ id: "z", value: 30 }], {
      name: "other",
      index: "id",
    });
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "width:700px;height:300px";
    panel.rowActions = {
      rows: {
        "@copy": {
          header: "Copy",
          position: "start",
          buttons: [{ action: "copy", label: "Copy", icon: "copy" }],
        },
      },
    };
    panel.config = {
      local: true,
      layout: {
        panels: { main: { table: "rows", columns: ["id", "value"] } },
        layout: { type: "tab-layout", tabs: ["main"] },
      },
    };
    window.lifecycle = { panel, errors: [] };
    panel.addEventListener("perspective-error", (e) =>
      lifecycle.errors.push(String(e.detail)),
    );
    document.body.append(panel);
    await panel.save();
  });
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toHaveCount(2);
}

test("new layouts preserve user expressions when panel IDs are reused", async ({
  page,
}) => {
  await mount(page);
  const saved = await page.evaluate(async () => {
    const { panel } = lifecycle;
    panel.config = {
      local: true,
      layout: {
        panels: {
          main: {
            table: "other",
            expressions: { Copy: '"id"' },
            columns: ["Copy", "value"],
          },
        },
        layout: { type: "tab-layout", tabs: ["main"] },
      },
    };
    return panel.save();
  });
  expect(saved.panels.main).toMatchObject({
    expressions: { Copy: '"id"' },
    columns: ["Copy", "value"],
  });
});

test("removing grouped action columns cleans every dependent configuration", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { panel } = lifecycle;
    await panel.viewer.restore(
      { group_by: ["Copy"], aggregates: { Copy: "count" } },
      { panel: "main" },
    );
    const saved = await panel.save();
    panel.rowActions = {};
    await panel.save();
    return {
      saved,
      config: await panel.viewer.getViewConfig({ panel: "main" }),
      errors: lifecycle.errors,
    };
  });
  expect(result.saved.panels.main).toMatchObject({
    group_by: [],
    expressions: {},
    aggregates: {},
  });
  expect(result.config).toMatchObject({
    group_by: [],
    expressions: {},
    columns: ["id", "value"],
    aggregates: {},
  });
  expect(result.errors).toEqual([]);
});

test("reconnecting reconciles policies changed while detached", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const { panel } = lifecycle;
    panel.remove();
    panel.rowActions = {};
    await panel.save();
    document.body.append(panel);
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await lifecycle.panel.viewer.getViewConfig({ panel: "main" }))
            .columns,
      ),
    )
    .toEqual(["id", "value"]);
});

test("renaming an action identifier refreshes buttons without a view change", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    lifecycle.panel.rowActions = {
      rows: {
        "@new": {
          header: "Copy",
          position: "start",
          buttons: [{ action: "copy", label: "New copy", icon: "copy" }],
        },
      },
    };
    lifecycle.events = [];
    lifecycle.panel.addEventListener("perspective-row-action", (e) =>
      lifecycle.events.push(e.detail),
    );
  });
  const button = page.getByRole("button", { name: "New copy", exact: true });
  await expect(button).toHaveCount(2);
  await button.first().click();
  expect(await page.evaluate(() => lifecycle.events[0])).toMatchObject({
    column: "@new",
    key: "a",
  });
});

test("metadata requests do not overwrite concurrent column changes", async ({
  page,
}) => {
  await mount(page);
  const columns = await page.evaluate(async () => {
    const { panel } = lifecycle;
    const getTable = panel.viewer.getTable.bind(panel.viewer);
    let release,
      entered,
      once = true;
    const gate = new Promise((r) => (release = r)),
      started = new Promise((r) => (entered = r));
    Object.defineProperty(panel.viewer, "getTable", {
      configurable: true,
      value: async (...args) => {
        const table = await getTable(...args);
        return {
          get_name: () => table.get_name(),
          get_index: () => table.get_index(),
          schema: async () => {
            if (once) {
              once = false;
              entered();
              await gate;
            }
            return table.schema();
          },
        };
      },
    });
    panel.rowActions = {
      rows: {
        ...panel.rowActions.rows,
        "@more": {
          header: "More",
          position: "end",
          buttons: [{ action: "more", label: "More" }],
        },
      },
    };
    await started;
    await panel.viewer.restore({ columns: ["value", "id"] }, { panel: "main" });
    release();
    await panel.save();
    return (await panel.viewer.getViewConfig({ panel: "main" })).columns;
  });
  expect(columns).toEqual(["Copy", "value", "id", "More"]);
});

test("a conflicting panel does not prevent saving or configuring other panels", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "width:700px;height:300px";
    panel.rowActions = {
      rows: {
        "@bad": {
          header: "id",
          position: "start",
          buttons: [{ action: "bad", label: "Bad" }],
        },
      },
      other: {
        "@good": {
          header: "Good",
          position: "start",
          buttons: [{ action: "good", label: "Good" }],
        },
      },
    };
    panel.config = {
      local: true,
      layout: {
        panels: { bad: { table: "rows" }, good: { table: "other" } },
        layout: { type: "tab-layout", tabs: ["bad", "good"] },
      },
    };
    const errors = [];
    let ready = 0;
    panel.addEventListener("perspective-error", (e) =>
      errors.push(String(e.detail)),
    );
    panel.addEventListener("perspective-ready", () => ready++);
    document.body.append(panel);
    await panel.save();
    await panel.save();
    const before = {
      config: await panel.viewer.getViewConfig({ panel: "good" }),
      ready,
      errors: [...errors],
    };
    panel.rowActions = { other: panel.rowActions.other };
    await panel.save();
    await panel.save();
    return { before, ready, errors };
  });
  expect(result.before.config.columns).toContain("Good");
  expect(result.before.ready).toBe(0);
  expect(result.errors).toHaveLength(1);
  expect(result.ready).toBe(1);
});

test("data export omits action values and retains expressions, filters and sorting", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { panel } = lifecycle;
    await panel.viewer.restore(
      {
        expressions: { Copy: '"id"', doubled: '"value" * 2' },
        columns: ["id", "value", "doubled"],
        sort: [["value", "desc"]],
        filter: [["Copy", "==", "b"]],
      },
      { panel: "main" },
    );
    await panel.save();
    const before = await panel.viewer.saveWorkspace();
    const csv = await panel.exportData({ panel: "main" });
    const json = await panel.exportData({ panel: "main", format: "json" });
    return {
      before,
      after: await panel.viewer.saveWorkspace(),
      csv,
      json,
      raw: await panel.viewer.export({ method: "csv", panel: "main" }),
    };
  });
  expect(result.csv).toBe('"id","value","doubled"\n"b",20,40\n');
  expect(JSON.parse(result.json)).toEqual([
    { id: "b", value: 20, doubled: 40 },
  ]);
  expect(result.after).toEqual(result.before);
  expect(result.raw).toContain('"Copy"');
});

test("editing a generated expression preserves the edit and recovers when its action is removed", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { panel } = lifecycle;
    await panel.viewer.restore(
      { expressions: { Copy: '"value"' } },
      { panel: "main" },
    );
    const saved = await panel.save();
    await panel.save();
    panel.rowActions = {};
    const recovered = await panel.save();
    return { saved, recovered, errors: lifecycle.errors };
  });
  expect(result.saved.panels.main.expressions.Copy).toBe('"value"');
  expect(result.recovered.panels.main.expressions.Copy).toBe('"value"');
  expect(result.errors).toHaveLength(1);
});

test("chart switches remove action columns and restore them for Datagrid", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    await lifecycle.panel.viewer.restore(
      { plugin: "Y Bar", columns: ["value"] },
      { panel: "main" },
    );
    await lifecycle.panel.save();
  });
  expect(
    await page.evaluate(() =>
      lifecycle.panel.viewer.getViewConfig({ panel: "main" }),
    ),
  ).toMatchObject({ expressions: {}, columns: ["value"] });
  await page.evaluate(async () => {
    await lifecycle.panel.viewer.restore(
      { plugin: "Datagrid", columns: ["id", "value"] },
      { panel: "main" },
    );
    await lifecycle.panel.save();
  });
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toHaveCount(2);
});

test("partial layouts keep action ownership through grouped and flat views", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { panel } = lifecycle;
    const saved = [];
    for (const group_by of [["id"], []]) {
      panel.config = {
        ...panel.config,
        layout: {
          panels: {
            main: { table: "rows", columns: ["id", "value"], group_by },
          },
          layout: { type: "tab-layout", tabs: ["main"] },
        },
      };
      saved.push(await panel.save());
    }
    return { saved, errors: lifecycle.errors };
  });
  expect(result.errors).toEqual([]);
  for (const saved of result.saved)
    expect(saved.panels.main).toMatchObject({
      expressions: {},
      columns: ["id", "value"],
    });
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toHaveCount(2);
});

test("native channel removal retains clean action configuration", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { panel } = lifecycle;
    panel.config = {
      ...panel.config,
      channels: { rows: { columns: ["id", "value"] } },
    };
    await panel.save();
    await panel.viewer.restore(
      { columns: ["Copy", "value"] },
      { panel: "main" },
    );
    await panel.viewer.removePanel("main");
    const saved = await panel.saveClean();
    await panel.openChannel("rows");
    await panel.save();
    return { saved, errors: lifecycle.errors };
  });
  expect(result.saved.closed_channels.rows).toMatchObject({
    expressions: {},
    columns: ["value"],
  });
  expect(result.errors).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toHaveCount(2);
});

test("later panels use fresh plugin metadata after an earlier panel waits", async ({
  page,
}) => {
  await mount(page);
  const patches = await page.evaluate(async () => {
    const { panel } = lifecycle;
    panel.rowActions = {
      rows: panel.rowActions.rows,
      other: panel.rowActions.rows,
    };
    panel.config = {
      local: true,
      layout: {
        panels: {
          first: { table: "rows", columns: ["id", "value"] },
          second: { table: "other", columns: ["id", "value"] },
        },
        layout: { type: "tab-layout", tabs: ["first", "second"] },
      },
    };
    await panel.save();
    const getTable = panel.viewer.getTable.bind(panel.viewer),
      restore = panel.viewer.restore.bind(panel.viewer);
    let release,
      entered,
      once = true,
      chart = false;
    const gate = new Promise((r) => (release = r)),
      started = new Promise((r) => (entered = r)),
      patches = [];
    Object.defineProperty(panel.viewer, "getTable", {
      configurable: true,
      value: async (options) => {
        const table = await getTable(options);
        return {
          get_name: () => table.get_name(),
          get_index: () => table.get_index(),
          schema: async () => {
            if (once && options.panel === "first") {
              once = false;
              entered();
              await gate;
            }
            return table.schema();
          },
        };
      },
    });
    Object.defineProperty(panel.viewer, "restore", {
      configurable: true,
      value: (config, options) => {
        if (
          chart &&
          options.panel === "second" &&
          config.columns?.includes("Copy")
        )
          patches.push(config);
        return restore(config, options);
      },
    });
    panel.rowActions = { ...panel.rowActions };
    await started;
    await panel.viewer.restore(
      { plugin: "Y Bar", columns: ["value"] },
      { panel: "second" },
    );
    chart = true;
    release();
    await panel.save();
    return patches;
  });
  expect(patches).toEqual([]);
});

test("failed action restores report once and recover without losing ownership", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { panel } = lifecycle;
    const restore = panel.viewer.restore.bind(panel.viewer);
    Object.defineProperty(panel.viewer, "restore", {
      configurable: true,
      value: () => Promise.reject(new Error("Temporary restore failure")),
    });
    panel.rowActions = {
      rows: {
        "@more": {
          header: "More",
          position: "start",
          buttons: [{ action: "more", label: "More" }],
        },
      },
    };
    await panel.save();
    await panel.save();
    const errors = [...lifecycle.errors];
    Object.defineProperty(panel.viewer, "restore", {
      configurable: true,
      value: restore,
    });
    await panel.save();
    return {
      errors,
      config: await panel.viewer.getViewConfig({ panel: "main" }),
    };
  });
  expect(result.errors).toEqual(["Error: Temporary restore failure"]);
  expect(result.config.columns).toEqual(["More", "id", "value"]);
});

test("export rejects invalid requests and remains usable afterwards", async ({
  page,
}) => {
  await mount(page);
  await page.locator("regular-table td").nth(1).click();
  const result = await page.evaluate(async () => {
    const { panel } = lifecycle;
    let invalid;
    try {
      await panel.exportData({ format: "xml" }).catch((error) => {
        invalid = String(error);
      });
    } catch {
      throw new Error("exportData must return a promise for invalid options");
    }
    const csv = await panel.exportData(null);
    const pending = document.createElement("perspective-panel");
    pending.config = {
      local: true,
      wait_for_table: true,
      layout: {
        panels: { missing: { table: "not-created" } },
        layout: { type: "tab-layout", tabs: ["missing"] },
      },
    };
    document.body.append(pending);
    await pending.save();
    let missing;
    try {
      await pending.exportData({ panel: "missing" });
    } catch (error) {
      missing = String(error);
    }
    return { invalid, csv, missing };
  });
  expect(result.invalid).toContain("format must be csv or json");
  expect(result.csv).toContain('"id","value"');
  expect(result.missing).toContain("No `Table` set");
});

test("pending tables receive their actions when the table becomes available", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  await page.evaluate(async () => {
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "width:700px;height:300px";
    panel.rowActions = {
      late: {
        "@copy": {
          header: "Copy",
          position: "start",
          buttons: [{ action: "copy", label: "Copy" }],
        },
      },
    };
    panel.config = {
      local: true,
      wait_for_table: true,
      layout: {
        panels: { late: { table: "late" } },
        layout: { type: "tab-layout", tabs: ["late"] },
      },
    };
    window.pendingErrors = [];
    panel.addEventListener("perspective-error", (e) =>
      pendingErrors.push(String(e.detail)),
    );
    document.body.append(panel);
    await panel.save();
    await (
      await globalThis.__spadayPerspective.worker()
    ).table([{ id: 1, value: 10 }], { name: "late", index: "id" });
  });
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => pendingErrors)).toEqual([]);
});
