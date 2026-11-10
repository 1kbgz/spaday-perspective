import { expect, test } from "@playwright/test";

async function mount(page, count = 48) {
  await page.goto("/dist/index.html");
  await page.waitForFunction(() => !!globalThis.__spadayPerspective);
  await page.evaluate(async (count) => {
    const client = await globalThis.__spadayPerspective.worker();
    await client.table(
      Array.from({ length: 200 }, (_, id) => ({ id, value: id * 2 })),
      { name: "rows" },
    );
    const panel = document.createElement("perspective-panel");
    panel.id = "workspaces";
    panel.style.cssText = "width:1000px;height:500px";
    const names = Array.from({ length: count }, (_, i) => `panel-${i}`);
    panel.config = {
      local: true,
      layout: {
        layout: { type: "tab-layout", tabs: names, selected: 0 },
        panels: Object.fromEntries(
          names.map((id) => [
            id,
            { table: "rows", title: id, plugin: "Datagrid" },
          ]),
        ),
      },
    };
    document.body.append(panel);
    await panel.save();
  }, count);
}

test("layout-only workspaces retain inactive plugins and skip superseded queued restores", async ({
  page,
}, testInfo) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspaces");
    const base = await panel.save();
    const plugins = Array.from(
      panel.viewer.querySelectorAll("perspective-viewer-datagrid"),
    );
    let fullRestores = 0;
    const restores = [];
    const restore = panel.viewer.restoreWorkspace.bind(panel.viewer);
    Object.defineProperty(panel.viewer, "restoreWorkspace", {
      configurable: true,
      value: async (config, ...args) => {
        if (config.panels) fullRestores++;
        restores.push(config.layout?.selected);
        return restore(config, ...args);
      },
    });
    const longTasks = [];
    const observer = new PerformanceObserver((list) =>
      longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
      observer.observe({ type: "longtask" });
    const start = performance.now();
    for (const selected of [1, 2, 3])
      panel.config = {
        local: true,
        layout: { ...base, layout: { ...base.layout, selected } },
      };
    const final = await panel.save();
    const elapsed = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    return {
      elapsed,
      longTasks,
      fullRestores,
      restores,
      selected: final.layout.selected,
      retained: plugins.filter((plugin) => plugin.isConnected).length,
      count: plugins.length,
    };
  });
  await testInfo.attach("workspace-switch-timing", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  console.log("workspace-switch", JSON.stringify(result));
  expect(result.selected).toBe(3);
  expect(result.restores).toEqual([3]);
  expect(result.fullRestores).toBe(0);
  expect(result.retained).toBe(48);
});

test("an in-flight workspace finishes but queued intermediate workspaces are skipped", async ({
  page,
}) => {
  await mount(page, 3);
  await page.evaluate(async () => {
    const panel = document.querySelector("#workspaces");
    const base = await panel.save();
    window.workspaceCalls = [];
    const restore = panel.viewer.restoreWorkspace.bind(panel.viewer);
    Object.defineProperty(panel.viewer, "restoreWorkspace", {
      value: async (config, ...args) => {
        window.workspaceCalls.push(config.layout.selected);
        if (window.workspaceCalls.length === 1)
          await new Promise((resolve) => {
            window.releaseWorkspace = resolve;
          });
        return restore(config, ...args);
      },
    });
    window.workspaceBase = base;
    panel.config = {
      local: true,
      layout: { ...base, layout: { ...base.layout, selected: 1 } },
    };
  });
  await expect
    .poll(() => page.evaluate(() => !!window.releaseWorkspace))
    .toBe(true);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspaces");
    for (const selected of [0, 2])
      panel.config = {
        local: true,
        layout: {
          ...window.workspaceBase,
          layout: { ...window.workspaceBase.layout, selected },
        },
      };
    window.releaseWorkspace();
    return { saved: await panel.save(), calls: window.workspaceCalls };
  });
  expect(result.calls).toEqual([1, 2]);
  expect(result.saved.layout.selected).toBe(2);
});

test("restoring a saved workspace resets live edits instead of reusing stale cached config", async ({
  page,
}) => {
  await mount(page, 3);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspaces");
    const original = await panel.save();
    await panel.restorePanel("panel-1", {
      filter: [["id", "==", 7]],
      sort: [["value", "desc"]],
      group_by: ["value"],
      expressions: { doubled: '"id" * 2' },
      columns: ["id", "doubled"],
      aggregates: { id: "avg" },
    });
    const plugins = [
      ...panel.viewer.querySelectorAll("perspective-viewer-datagrid"),
    ];
    panel.config = { local: true, layout: original };
    return {
      saved: await panel.save(),
      original,
      retained: plugins.filter((plugin) => plugin.isConnected).length,
    };
  });
  expect(result.saved).toEqual(result.original);
  expect(result.retained).toBe(3);
});

// Use enough data and visible stacks to exercise rendering as well as tab reuse.
// Timings are report artifacts, never pass/fail thresholds tied to one machine.
test("changed saved workspaces reuse a large workspace and match full restoration", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/dist/index.html");
  await page.waitForFunction(() => !!globalThis.__spadayPerspective);
  const result = await page.evaluate(async () => {
    const client = await globalThis.__spadayPerspective.worker();
    const start = performance.now();
    await client.table(
      Array.from({ length: 100_000 }, (_, id) => ({
        id,
        symbol: ["AAPL", "MSFT", "NVDA", "AMZN"][id % 4],
        desk: `Desk ${id % 12}`,
        price: 100 + (id % 1000) / 10,
        quantity: 1 + (id % 200),
        notional: (100 + (id % 1000) / 10) * (1 + (id % 200)),
      })),
      { name: "trades", index: "id" },
    );
    const panel = document.createElement("perspective-panel");
    panel.id = "workspaces";
    panel.style.cssText = "width:1200px;height:700px";
    const names = Array.from({ length: 48 }, (_, i) => `panel-${i}`);
    panel.config = {
      local: true,
      layout: {
        layout: {
          type: "split-layout",
          orientation: "horizontal",
          sizes: [1, 1, 1, 1],
          children: Array.from({ length: 4 }, (_, i) => ({
            type: "tab-layout",
            tabs: names.slice(i * 12, (i + 1) * 12),
            selected: 0,
          })),
        },
        panels: Object.fromEntries(
          names.map((id, i) => [
            id,
            {
              table: "trades",
              title: id,
              plugin: "Datagrid",
              columns: ["symbol", "price", "quantity", "notional"],
              group_by: i % 3 === 0 ? ["desk", "symbol"] : [],
              sort: [["notional", "desc"]],
              filter: [["quantity", ">", i]],
            },
          ]),
        ),
      },
    };
    document.body.append(panel);
    const original = await panel.save();
    const initialMs = performance.now() - start;
    const target = structuredClone(original);
    for (const id of ["panel-0", "panel-1", "panel-12", "panel-25"])
      Object.assign(target.panels[id], {
        filter: [["symbol", "==", "MSFT"]],
        sort: [["price", "asc"]],
        title: `Filtered ${id}`,
      });
    target.layout.children[0].selected = 1;
    const longTasks = [];
    const observer = new PerformanceObserver((list) =>
      longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
      observer.observe({ type: "longtask" });
    const fullStart = performance.now();
    await panel.viewer.restoreWorkspace(target);
    await panel.viewer.flush();
    const fullMs = performance.now() - fullStart;
    const expected = await panel.save();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fullLongTasks = longTasks.splice(0);
    observer.disconnect();
    await panel.viewer.restoreWorkspace(original);
    await panel.viewer.flush();
    const plugins = [
      ...panel.viewer.querySelectorAll("perspective-viewer-datagrid"),
    ];
    const restoredPanels = [];
    const restore = panel.viewer.restore.bind(panel.viewer);
    Object.defineProperty(panel.viewer, "restore", {
      value: async (config, options) => {
        restoredPanels.push(options.panel);
        return restore(config, options);
      },
    });
    if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
      observer.observe({ type: "longtask" });
    const incrementalStart = performance.now();
    panel.config = { local: true, layout: target };
    const actual = await panel.save();
    const incrementalMs = performance.now() - incrementalStart;
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    return {
      initialMs,
      fullMs,
      incrementalMs,
      fullLongTasks,
      incrementalLongTasks: longTasks,
      restoredPanels,
      retained: plugins.filter((plugin) => plugin.isConnected).length,
      expected,
      actual,
    };
  });
  const { expected, actual, ...timing } = result;
  console.log("large-workspace-switch", JSON.stringify(timing));
  await testInfo.attach("large-workspace-switch-timing", {
    body: JSON.stringify(timing, null, 2),
    contentType: "application/json",
  });
  expect(actual).toEqual(expected);
  expect(result.retained).toBe(48);
  expect(result.restoredPanels).toEqual([
    "panel-0",
    "panel-1",
    "panel-12",
    "panel-25",
  ]);
});

for (const change of ["partial", "removed", "style"])
  test(`${change} workspaces keep replacement semantics`, async ({ page }) => {
    await mount(page, 3);
    const result = await page.evaluate(async (change) => {
      const panel = document.querySelector("#workspaces");
      const saved = await panel.save();
      const plugins = [
        ...panel.viewer.querySelectorAll("perspective-viewer-datagrid"),
      ];
      await panel.restorePanel("panel-1", {
        filter: [["id", "==", 7]],
        ...(change === "style" && {
          plugin_config: { edit_mode: "SELECT_ROW" },
        }),
      });
      if (change === "partial")
        saved.panels["panel-1"] = { table: "rows", plugin: "Datagrid" };
      if (change === "removed") {
        delete saved.panels["panel-2"];
        saved.layout.tabs.pop();
      }
      panel.config = { local: true, layout: saved };
      return {
        saved: await panel.save(),
        retained: plugins.filter((plugin) => plugin.isConnected).length,
      };
    }, change);
    expect(result.retained).toBe(0);
    expect(result.saved.panels["panel-1"].filter).toEqual([]);
    expect(result.saved.panels["panel-1"].plugin_config.edit_mode).not.toBe(
      "SELECT_ROW",
    );
    if (change === "removed")
      expect(result.saved.panels).not.toHaveProperty("panel-2");
  });
