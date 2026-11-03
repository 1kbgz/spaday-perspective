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
    panel.id = "profiles";
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

test("layout-only profiles retain inactive plugins and skip superseded queued restores", async ({
  page,
}, testInfo) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#profiles");
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
  await testInfo.attach("profile-switch-timing", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  console.log("profile-switch", JSON.stringify(result));
  expect(result.selected).toBe(3);
  expect(result.restores).toEqual([3]);
  expect(result.fullRestores).toBe(0);
  expect(result.retained).toBe(48);
});

test("an in-flight profile finishes but queued intermediate profiles are skipped", async ({
  page,
}) => {
  await mount(page, 3);
  await page.evaluate(async () => {
    const panel = document.querySelector("#profiles");
    const base = await panel.save();
    window.profileCalls = [];
    const restore = panel.viewer.restoreWorkspace.bind(panel.viewer);
    Object.defineProperty(panel.viewer, "restoreWorkspace", {
      value: async (config, ...args) => {
        window.profileCalls.push(config.layout.selected);
        if (window.profileCalls.length === 1)
          await new Promise((resolve) => {
            window.releaseProfile = resolve;
          });
        return restore(config, ...args);
      },
    });
    window.profileBase = base;
    panel.config = {
      local: true,
      layout: { ...base, layout: { ...base.layout, selected: 1 } },
    };
  });
  await expect
    .poll(() => page.evaluate(() => !!window.releaseProfile))
    .toBe(true);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#profiles");
    for (const selected of [0, 2])
      panel.config = {
        local: true,
        layout: {
          ...window.profileBase,
          layout: { ...window.profileBase.layout, selected },
        },
      };
    window.releaseProfile();
    return { saved: await panel.save(), calls: window.profileCalls };
  });
  expect(result.calls).toEqual([1, 2]);
  expect(result.saved.layout.selected).toBe(2);
});

test("restoring a saved profile resets live edits instead of reusing stale cached config", async ({
  page,
}) => {
  await mount(page, 3);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#profiles");
    const original = await panel.save();
    await panel.restorePanel("panel-1", { filter: [["id", "==", 7]] });
    panel.config = { local: true, layout: original };
    return await panel.save();
  });
  expect(result.panels["panel-1"].filter).toEqual([]);
});
