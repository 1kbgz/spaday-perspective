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

for (const declared of [false, true]) {
  test(`native panel removal preserves the last edited ${declared ? "table" : "channel"} configuration`, async ({
    page,
  }) => {
    await mountChannels(
      page,
      declared ? { tables: ["quotes", "orders"], channels: {} } : {},
    );
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
}

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

for (const tables of [
  ["quotes", "orders"],
  [{ name: "quotes" }, { name: "orders" }],
]) {
  test(`declared tables support channel open, close, and saved configuration with ${typeof tables[0]} entries`, async ({
    page,
  }) => {
    await mountChannels(page, { tables, channels: {} });
    const result = await page.evaluate(async () => {
      const panel = document.querySelector("#workspace");
      await panel.openChannel("quotes");
      const selected = await panel.save();
      await panel.restorePanel("quotes", {
        columns: ["price"],
        filter: [["symbol", "==", "AAPL"]],
      });
      await panel.closeChannel("quotes");
      const closed = await panel.saveClean();
      panel.config = { ...panel.config, layout: closed };
      await panel.openChannel("quotes");
      const reopened = await panel.save();
      await panel.closeChannel("quotes");
      await panel.closeChannel("orders");
      panel.config = { ...panel.config, layout: { panels: {}, layout: null } };
      await panel.openChannel("orders");
      let unknown;
      try {
        await panel.openChannel("toString");
      } catch (error) {
        unknown = error.message;
      }
      await panel.openChannel("quotes");
      return {
        selected,
        closed,
        reopened,
        defaults: await panel.save(),
        unknown,
      };
    });
    expect(result.selected.layout.selected).toBe(0);
    expect(Object.keys(result.selected.panels).sort()).toEqual([
      "orders",
      "quotes",
    ]);
    expect(result.closed.closed_channels.quotes.columns).toEqual(["price"]);
    const reopened = Object.values(result.reopened.panels).find(
      (panel) => panel.table === "quotes",
    );
    expect(reopened.filter).toEqual([["symbol", "==", "AAPL"]]);
    expect(reopened.columns).toEqual(["price"]);
    expect(
      Object.values(result.defaults.panels).map((panel) => panel.plugin),
    ).toEqual(["Datagrid", "Datagrid"]);
    expect(result.unknown).toBe("Unknown channel: toString");
    // Declared tables do not implicitly add toolbar entries.
    await expect(
      page.locator(".perspective-panel-titlebar select option"),
    ).toHaveCount(1);
  });
}

test("declared table opens beside master panels and respects single-tab mode", async ({
  page,
}) => {
  await mountChannels(page, {
    tables: ["quotes", "orders"],
    channels: {},
    single_tab: true,
    layout: {
      layout: { type: "tab-layout", tabs: ["master"] },
      masters: ["master"],
      panels: {
        master: { table: "quotes", plugin: "Datagrid", group_by: ["symbol"] },
      },
    },
  });
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    await panel.openChannel("orders");
    const opened = await panel.save();
    panel.config = {
      ...panel.config,
      layout: {
        ...opened,
        layout: {
          ...opened.layout,
          children: [
            opened.layout.children[0],
            { type: "tab-layout", tabs: ["detail"] },
          ],
        },
        panels: {
          master: opened.panels.master,
          detail: { table: "quotes", plugin: "Datagrid" },
        },
      },
    };
    await panel.openChannel("orders");
    return { opened, replaced: await panel.save() };
  });
  for (const workspace of [result.opened, result.replaced]) {
    expect(workspace.masters).toEqual(["master"]);
    expect(workspace.layout.children.map((stack) => stack.tabs)).toEqual([
      ["master"],
      ["channel:orders"],
    ]);
    expect(Object.keys(workspace.panels).sort()).toEqual([
      "channel:orders",
      "master",
    ]);
  }
});

test("restorePanel serializes partial updates with layout changes and isolates same-table panels", async ({
  page,
}) => {
  await mountChannels(page);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    panel.config = {
      ...panel.config,
      layout: {
        layout: { type: "tab-layout", tabs: ["first", "second"] },
        panels: {
          first: {
            table: "quotes",
            plugin: "Datagrid",
            columns: ["symbol", "price"],
          },
          second: {
            table: "quotes",
            plugin: "Datagrid",
            columns: ["symbol", "price"],
          },
        },
      },
    };
    const config = { filter: [["symbol", "==", "NVDA"]] };
    const first = panel.restorePanel("first", config);
    config.filter[0][2] = "AAPL";
    const second = panel.restorePanel("first", { sort: [["price", "desc"]] });
    await Promise.all([first, second]);
    const saved = await panel.save();
    panel.config = {
      ...panel.config,
      layout: {
        layout: { type: "tab-layout", tabs: ["second"] },
        panels: { second: saved.panels.second },
      },
    };
    const errors = [];
    for (const [id, config] of [
      ["first", { filter: [] }],
      ["toString", {}],
      ["second", { plugin_config: { edit_mode: "invalid" } }],
      ["second", null],
      ["second", { filter: [["absent", "==", 1]] }],
    ]) {
      try {
        await panel.restorePanel(id, config);
      } catch (error) {
        errors.push(String(error));
      }
    }
    await panel.restorePanel("second", { filter: [["symbol", "==", "AAPL"]] });
    return { saved, errors, recovered: await panel.save() };
  });
  expect(result.saved.panels.first.filter).toEqual([["symbol", "==", "NVDA"]]);
  expect(result.saved.panels.first.sort).toEqual([["price", "desc"]]);
  expect(result.saved.panels.second.filter).toEqual([]);
  expect(result.errors).toHaveLength(5);
  expect(result.errors[0]).toContain("Unknown panel: first");
  expect(result.errors[1]).toContain("Unknown panel: toString");
  expect(result.errors[2]).toContain("config.plugin_config.edit_mode");
  expect(result.errors[3]).toContain("config: expected object");
  expect(result.recovered.panels.second.filter).toEqual([
    ["symbol", "==", "AAPL"],
  ]);
});

test("restorePanel validates plugin config against the panel's effective plugin", async ({
  page,
}) => {
  await mountChannels(page, {
    layout: {
      layout: { type: "tab-layout", tabs: ["chart"] },
      panels: {
        chart: {
          table: "quotes",
          plugin: "Y Bar",
          columns: ["price"],
          group_by: ["symbol"],
        },
      },
    },
  });
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    await panel.restorePanel("chart", { plugin_config: {} });
    let error;
    try {
      await panel.restorePanel("chart", {
        plugin: "Datagrid",
        plugin_config: { edit_mode: "invalid" },
      });
    } catch (reason) {
      error = String(reason);
    }
    return { error, workspace: await panel.save() };
  });
  expect(result.error).toContain("config.plugin_config.edit_mode");
  expect(result.workspace.panels.chart.plugin).toBe("Y Bar");
});
