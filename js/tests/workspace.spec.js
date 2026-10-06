import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const legacyLayouts = JSON.parse(
  readFileSync(
    new URL(
      "../../spaday_perspective/tests/fixtures/legacy-layouts.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

async function mountChannels(page, options = {}) {
  await page.goto("/dist/index.html");
  await page.evaluate(async (options) => {
    const worker = await globalThis.__spadayPerspective.worker();
    for (const name of ["quotes", "orders"]) {
      await worker.table(
        [
          { symbol: "NVDA", price: 181 },
          { symbol: "AAPL", price: 210 },
        ],
        { name },
      );
    }
    const panel = document.createElement("perspective-panel");
    panel.id = "workspace";
    panel.style.cssText = "display:block;width:800px;height:400px";
    panel.theme = "dark";
    panel.toolbar = true;
    panel.config = {
      local: true,
      channels: {
        quotes: { title: "Quotes", plugin: "Datagrid" },
        orders: { title: "Orders", plugin: "Datagrid" },
      },
      layout: {
        layout: { type: "tab-layout", tabs: ["quotes", "orders"], selected: 1 },
        panels: {
          quotes: {
            table: "quotes",
            plugin: "Datagrid",
            columns: ["symbol"],
            filter: [["symbol", "==", "NVDA"]],
          },
          orders: { table: "orders", plugin: "Datagrid" },
        },
      },
      ...options,
    };
    document.body.appendChild(panel);
    await panel.save();
  }, options);
}

test("failed restores can retry the same layout and channel operations recover after rejection", async ({
  page,
}) => {
  await mountChannels(page);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    const errors = [];
    panel.addEventListener("perspective-error", (event) =>
      errors.push(String(event.detail)),
    );
    const missing = {
      layout: { type: "tab-layout", tabs: ["late"] },
      panels: { late: { table: "late" } },
    };
    panel.config = { ...panel.config, layout: missing };
    // A failed upstream restore may leave a table-less panel that cannot be saved.
    await panel.save().catch(() => undefined);
    const worker = await globalThis.__spadayPerspective.worker();
    await worker.table([{ symbol: "MSFT" }], { name: "late" });
    panel.config = { ...panel.config, layout: missing };
    const recovered = await panel.save();
    let unknown;
    try {
      await panel.openChannel("unknown");
    } catch (error) {
      unknown = error.message;
    }
    await panel.openChannel("quotes");
    await panel.closeChannel("quotes");
    await panel.openChannel("quotes");
    return { errors, recovered, final: await panel.save(), unknown };
  });
  expect(result.errors).toHaveLength(1);
  expect(Object.values(result.recovered.panels).map((p) => p.table)).toEqual([
    "late",
  ]);
  expect(result.unknown).toBe("Unknown channel: unknown");
  expect(
    Object.values(result.final.panels)
      .map((p) => p.table)
      .sort(),
  ).toEqual(["late", "quotes"]);
});

test("channel controls retain edited configs through close, save, reload, and reopen", async ({
  page,
}) => {
  await mountChannels(page);
  await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    const saved = await panel.save();
    const id = Object.keys(saved.panels).find(
      (id) => saved.panels[id].table === "quotes",
    );
    await panel.viewer.restore(
      { columns: ["price"], sort: [["price", "desc"]] },
      { panel: id },
    );
    await panel.closeChannel("quotes");
    const clean = await panel.saveClean();
    localStorage.setItem("saved-workspace", JSON.stringify(clean));
  });
  await page.reload();
  await page.evaluate(async () => {
    const worker = await globalThis.__spadayPerspective.worker();
    for (const name of ["quotes", "orders"])
      await worker.table([{ symbol: "NVDA", price: 181 }], { name });
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "display:block;width:800px;height:400px";
    panel.theme = "light";
    panel.toolbar = true;
    panel.config = {
      local: true,
      channels: { quotes: { title: "Quotes" }, orders: {} },
      layout: JSON.parse(localStorage.getItem("saved-workspace")),
    };
    document.body.appendChild(panel);
    await panel.save();
  });
  const closed = await page.evaluate(() =>
    document.querySelector("perspective-panel").saveClean(),
  );
  expect(closed.closed_channels.quotes).toMatchObject({
    columns: ["price"],
    sort: [["price", "desc"]],
    filter: [["symbol", "==", "NVDA"]],
  });
  expect(closed.closed_channels.quotes).not.toHaveProperty("theme");
  await page.getByLabel("Open channel").selectOption("quotes");
  const reopened = await page.evaluate(() =>
    document.querySelector("perspective-panel").save(),
  );
  expect(
    Object.values(reopened.panels).find((p) => p.table === "quotes"),
  ).toMatchObject({
    columns: ["price"],
    theme: "Pro Light",
    sort: [["price", "desc"]],
  });
  expect(reopened.closed_channels).toBeUndefined();
  await page.getByRole("button", { name: "Close channel" }).click();
  expect(
    Object.values(
      (
        await page.evaluate(() =>
          document.querySelector("perspective-panel").save(),
        )
      ).panels,
    ).map((p) => p.table),
  ).toEqual(["orders"]);
});

test("single_tab prepares the selected layout before restore and retains hidden channels", async ({
  page,
}) => {
  await mountChannels(page, { single_tab: true });
  const initial = await page.evaluate(() =>
    document.querySelector("#workspace").saveClean(),
  );
  expect(Object.values(initial.panels).map((p) => p.table)).toEqual(["orders"]);
  expect(initial.closed_channels.quotes.columns).toEqual(["symbol"]);
  await expect(page.locator("perspective-viewer-datagrid")).toHaveCount(1);
  await page.getByLabel("Open channel").selectOption("quotes");
  const switched = await page.evaluate(() =>
    document.querySelector("#workspace").saveClean(),
  );
  expect(Object.values(switched.panels).map((p) => p.table)).toEqual([
    "quotes",
  ]);
  expect(switched.closed_channels.orders.table).toBe("orders");
  await expect(page.locator("perspective-viewer-datagrid")).toHaveCount(1);
  await page.getByRole("button", { name: "Close channel" }).click();
  expect(
    (await page.evaluate(() => document.querySelector("#workspace").save()))
      .panels,
  ).toEqual({});
  await page.getByLabel("Open channel").selectOption("orders");
  expect(
    Object.values(
      (await page.evaluate(() => document.querySelector("#workspace").save()))
        .panels,
    ).map((p) => p.table),
  ).toEqual(["orders"]);
});

test("native panel removal preserves the last edited channel configuration", async ({
  page,
}) => {
  await mountChannels(page);
  const saved = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    const workspace = await panel.save();
    const id = Object.keys(workspace.panels).find(
      (id) => workspace.panels[id].table === "quotes",
    );
    const updated = new Promise((resolve) =>
      panel.addEventListener("perspective-config-update", resolve, {
        once: true,
      }),
    );
    await panel.viewer.restore(
      { columns: ["price"], title: "Edited quotes" },
      { panel: id },
    );
    await updated;
    await panel.viewer.removePanel(id);
    return panel.saveClean();
  });
  expect(saved.closed_channels.quotes).toMatchObject({
    columns: ["price"],
    title: "Edited quotes",
  });
});

test("master theme overrides survive restoration and live application theme changes", async ({
  page,
}) => {
  await mountChannels(page, {
    master_theme: "light",
    layout: {
      layout: {
        type: "split-layout",
        orientation: "horizontal",
        sizes: [1, 3],
        children: [
          { type: "tab-layout", tabs: ["filter"] },
          { type: "tab-layout", tabs: ["detail"] },
        ],
      },
      panels: {
        filter: { table: "quotes", theme: "Pro Dark" },
        detail: { table: "orders", theme: "Pro Light" },
      },
      masters: ["filter"],
      global_filters: [["symbol", "==", "NVDA"]],
    },
  });
  const check = async () =>
    page.evaluate(async () => {
      const panel = document.querySelector("#workspace");
      const saved = await panel.save();
      await panel.viewer.flush();
      return {
        master: saved.panels[saved.masters[0]].theme,
        detail: Object.values(saved.panels).find((p) => p.table === "orders")
          .theme,
        filters: saved.global_filters,
        backgrounds: [...panel.querySelectorAll("perspective-viewer-datagrid")]
          .map((grid) => getComputedStyle(grid).backgroundColor)
          .filter(Boolean),
      };
    });
  expect(await check()).toMatchObject({
    master: "Pro Light",
    detail: "Pro Dark",
    filters: [["symbol", "==", "NVDA"]],
  });
  expect((await check()).backgrounds.sort()).toEqual(
    ["rgb(255, 255, 255)", "rgb(36, 37, 38)"].sort(),
  );
  await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    panel.autopause = true;
    await panel.save();
    panel.style.display = "none";
  });
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    panel.theme = "light";
    panel.theme = "dark";
    await panel.save();
    panel.style.display = "block";
  });
  expect(await check()).toMatchObject({
    master: "Pro Light",
    detail: "Pro Dark",
  });
  await page.evaluate(() => {
    document.querySelector("#workspace").theme = "light";
  });
  expect(await check()).toMatchObject({
    master: "Pro Light",
    detail: "Pro Light",
  });
  await page.evaluate(() => {
    document.querySelector("#workspace").theme = "dark";
  });
  expect(await check()).toMatchObject({
    master: "Pro Light",
    detail: "Pro Dark",
  });
});

for (const theme of ["dark", "light"]) {
  test(`restores saved layouts in ${theme} mode without painting the saved theme`, async ({
    page,
  }) => {
    await page.goto("/dist/index.html");
    const result = await page.evaluate(async (mode) => {
      const worker = await globalThis.__spadayPerspective.worker();
      await worker.table([{ symbol: "NVDA", price: 181 }], { name: "quotes" });
      const panel = document.createElement("perspective-panel");
      panel.style.cssText = "display:block;width:800px;height:400px";
      panel.theme = mode;
      panel.config = {
        local: true,
        layout: {
          layout: { type: "tab-layout", tabs: ["initial"] },
          panels: { initial: { table: "quotes", plugin: "Datagrid" } },
        },
      };
      document.body.appendChild(panel);
      await panel.save();
      await panel.viewer.flush();
      const background = () =>
        [...panel.querySelectorAll("perspective-viewer-datagrid")]
          .map((grid) => getComputedStyle(grid).backgroundColor)
          .filter(Boolean);
      const expected = background()[0];
      const calls = [];
      const frames = [];
      const viewer = panel.viewer;
      for (const method of ["restoreWorkspace", "restore"]) {
        const original = viewer[method].bind(viewer);
        viewer[method] = async (...args) => {
          calls.push({ method, args: structuredClone(args) });
          return original(...args);
        };
      }
      let sampling = true;
      const sample = () => {
        frames.push(background());
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const layout = {
        layout: { type: "tab-layout", tabs: ["a", "b"], selected: 1 },
        panels: Object.fromEntries(
          ["a", "b"].map((id) => [
            id,
            {
              table: "quotes",
              plugin: "Datagrid",
              title: id,
              theme: mode === "dark" ? "Pro Light" : "Pro Dark",
            },
          ]),
        ),
      };
      const original = JSON.stringify(layout);
      panel.config = { local: true, layout };
      const saved = await panel.save();
      await viewer.flush();
      await new Promise(requestAnimationFrame);
      sampling = false;
      frames.push(background());
      const clean = await panel.saveClean();
      panel.config = { local: true, layout: clean };
      await panel.save();
      await viewer.flush();
      return {
        expected,
        frames,
        calls,
        saved,
        chrome: panel.viewer.getAttribute("theme"),
        reloaded: background(),
        unchanged: JSON.stringify(layout) === original,
      };
    }, theme);
    expect(result.unchanged).toBe(true);
    expect(result.saved.layout.selected).toBe(1);
    expect(result.chrome).toBe(theme === "dark" ? "Pro Dark" : "Pro Light");
    expect(result.frames.flat().length).toBeGreaterThan(0);
    expect([...new Set(result.frames.flat())]).toEqual([result.expected]);
    expect(result.reloaded).toEqual([result.expected, result.expected]);
    expect(Object.values(result.saved.panels).map((p) => p.theme)).toEqual([
      theme === "dark" ? "Pro Dark" : "Pro Light",
      theme === "dark" ? "Pro Dark" : "Pro Light",
    ]);
    expect(result.calls.filter((call) => call.method === "restore")).toEqual(
      [],
    );
  });
}

test("hidden workspaces accept repeated theme changes with auto-pause enabled", async ({
  page,
}) => {
  await mountChannels(page, { master_theme: "light" });
  await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    panel.autopause = true;
    await panel.save();
    panel.style.display = "none";
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const panel = document.querySelector("#workspace");
    panel.theme = "light";
    panel.theme = "dark";
    window.hiddenThemeSave = panel.save().then(() => {
      window.hiddenThemeSaved = true;
    });
  });
  await expect
    .poll(() => page.evaluate(() => window.hiddenThemeSaved))
    .toBe(true);
  await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    panel.style.display = "block";
    await panel.viewer.flush();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll("perspective-viewer-datagrid")].map(
          (grid) => getComputedStyle(grid).backgroundColor,
        ),
      ),
    )
    .toEqual(["rgb(36, 37, 38)", "rgb(36, 37, 38)"]);
  await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    await panel.openChannel("quotes");
    await panel.viewer.flush();
  });
  await expect(
    page
      .locator("perspective-viewer-datagrid regular-table")
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const saved = await document.querySelector("#workspace").save();
      return Object.values(saved.panels).map((panel) => panel.theme);
    }),
  ).toEqual(["Pro Dark", "Pro Dark"]);
});

test("auto-pause stops hidden grid rendering while table updates continue", async ({
  page,
}) => {
  await mountChannels(page);
  await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    panel.autopause = true;
    await panel.save();
    await panel.viewer.flush();
    window.renderCalls = 0;
    for (const grid of panel.querySelectorAll("perspective-viewer-datagrid")) {
      for (const method of ["update", "draw"]) {
        const original = grid[method].bind(grid);
        grid[method] = (...args) => {
          window.renderCalls++;
          return original(...args);
        };
      }
    }
    window.streamingTable = await (
      await globalThis.__spadayPerspective.worker()
    ).open_table("orders");
    await window.streamingTable.update([{ symbol: "MSFT", price: 450 }]);
  });
  await expect
    .poll(() => page.evaluate(() => window.renderCalls))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    document.querySelector("#workspace").style.display = "none";
  });
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    window.renderCalls = 0;
    await window.streamingTable.update([{ symbol: "GOOG", price: 250 }]);
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.streamingTable.size())).toBe(4);
  expect(await page.evaluate(() => window.renderCalls)).toBe(0);
  await page.evaluate(() => {
    document.querySelector("#workspace").style.display = "block";
  });
  await expect(
    page
      .locator("perspective-viewer-datagrid regular-table tbody td")
      .filter({ hasText: "GOOG" }),
  ).toBeVisible();
});

for (const fixture of legacyLayouts) {
  test(`migrates ${fixture.name} through the real workspace`, async ({
    page,
  }) => {
    await mountChannels(page, { layout: fixture.input });
    const result = await page.evaluate(async (input) => {
      const { migrateLayout } = await import("/dist/cdn/index.js");
      const panel = document.querySelector("#workspace");
      const converted = migrateLayout(input);
      const saved = await panel.save();
      panel.config = { ...panel.config, layout: saved };
      return {
        converted,
        saved,
        roundtrip: await panel.save(),
        unchanged: migrateLayout(converted) === converted,
      };
    }, fixture.input);
    expect(result.converted.layout).toEqual(fixture.layout);
    expect(result.unchanged).toBe(true);
    expect(result.converted.panels).toEqual(fixture.input.viewers);
    expect(result.converted.masters ?? []).toEqual(fixture.masters);
    expect(
      Object.values(result.saved.panels)
        .map((p) => p.table)
        .sort(),
    ).toEqual(
      Object.values(fixture.input.viewers)
        .map((p) => p.table)
        .sort(),
    );
    expect(result.saved.masters ?? []).toHaveLength(fixture.masters.length);
    const semanticLayout = (workspace) => {
      const tree = (node) =>
        node.type === "tab-layout"
          ? { ...node, tabs: node.tabs.map((id) => workspace.panels[id]) }
          : { ...node, children: node.children.map(tree) };
      return {
        layout: tree(workspace.layout),
        masters: (workspace.masters ?? []).map((id) => workspace.panels[id]),
      };
    };
    expect(semanticLayout(result.roundtrip)).toEqual(
      semanticLayout(result.saved),
    );
    if (fixture.input.sizes?.length)
      expect(result.saved.layout.sizes).toEqual(fixture.input.sizes);
    if (fixture.name.startsWith("master-detail")) {
      expect(result.saved.layout.children[1].selected).toBe(1);
      expect(
        Object.values(result.saved.panels).find((p) => p.title === "Second")
          .columns,
      ).toEqual(["symbol"]);
    }
  });
}
