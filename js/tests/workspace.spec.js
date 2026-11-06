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

test("canonical and legacy workspace saves round-trip retained panel settings", async ({
  page,
}) => {
  await mountChannels(page);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    const { layout, channels, ...connection } = panel.config;
    const errors = [];
    panel.addEventListener("perspective-error", (event) =>
      errors.push(String(event.detail)),
    );
    panel.config = {
      ...connection,
      workspace: layout,
      panel_defaults: channels,
    };
    await panel.saveWorkspace();
    await panel.restorePanel("quotes", {
      columns: ["price"],
      columns_config: { price: { column_size_override: 180, bold: true } },
    });
    await panel.restorePanel("orders", {
      columns_config: { price: { column_size_override: 200, bold: true } },
    });
    await panel.closeTablePanels("quotes");
    const canonical = await panel.saveWorkspace();
    const portable = await panel.savePortableWorkspace();
    const legacy = await panel.save();
    const legacyPortable = await panel.saveClean();
    const restored = [];
    for (const workspace of [canonical, legacy, portable, legacyPortable]) {
      panel.config = {
        ...connection,
        panel_defaults: channels,
        workspace: JSON.stringify(workspace),
      };
      await panel.saveWorkspace();
      await panel.openTablePanel("quotes");
      restored.push(
        Object.values((await panel.saveWorkspace()).panels).find(
          (p) => p.table === "quotes",
        ),
      );
    }
    panel.config = { ...connection, channels, layout: JSON.stringify(legacy) };
    await panel.save();
    panel.config = { ...panel.config, layout: canonical };
    await panel.openChannel("quotes");
    return {
      canonical,
      errors,
      portable,
      legacy,
      legacyPortable,
      restored,
      authored: panel.config,
      final: await panel.save(),
    };
  });
  const retained = result.canonical.retained_panel_configs_by_table.quotes;
  expect(result.errors).toEqual([]);
  expect(retained.theme).toBe("Pro Dark");
  expect(retained.columns_config.price.column_size_override).toBe(180);
  expect(result.canonical).not.toHaveProperty("closed_channels");
  expect(result.legacy.closed_channels.quotes).toEqual(retained);
  expect(result.legacy).not.toHaveProperty("retained_panel_configs_by_table");
  const portable = result.portable.retained_panel_configs_by_table.quotes;
  expect(portable).not.toHaveProperty("theme");
  expect(portable.columns_config.price).not.toHaveProperty(
    "column_size_override",
  );
  expect(portable.columns_config.price.bold).toBe(true);
  expect(result.legacyPortable.closed_channels.quotes).toEqual(portable);
  expect(
    result.canonical.panels.orders.columns_config.price.column_size_override,
  ).toBe(200);
  expect(result.portable.panels.orders).not.toHaveProperty("theme");
  expect(result.portable.panels.orders.columns_config.price).toEqual({
    bold: true,
  });
  for (const restored of result.restored) {
    expect(restored.columns).toEqual(["price"]);
    expect(restored.filter).toEqual([["symbol", "==", "NVDA"]]);
  }
  expect(result.authored).not.toHaveProperty("workspace");
  expect(
    Object.values(result.final.panels).filter((p) => p.table === "quotes"),
  ).toHaveLength(1);
});

test("canonical table operations close all panels and respect selected-tab restoration", async ({
  page,
}) => {
  await mountChannels(page);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    panel.config = {
      local: true,
      tables: ["quotes", "orders"],
      panel_defaults: { quotes: { columns: ["price"] } },
      workspace: {
        layout: {
          type: "tab-layout",
          tabs: ["master", "quotes", "orders"],
          selected: 2,
        },
        masters: ["master"],
        panels: {
          master: { table: "quotes", plugin: "Datagrid" },
          quotes: { table: "quotes", plugin: "Datagrid" },
          orders: { table: "orders", plugin: "Datagrid" },
        },
      },
    };
    await panel.saveWorkspace();
    await panel.closeTablePanels("quotes");
    const closed = await panel.saveWorkspace();
    await panel.openChannel("quotes");
    await panel.closeChannel("quotes");
    const legacyClosed = await panel.saveWorkspace();
    panel.config = { ...panel.config, restore_selected_tabs_only: true };
    await panel.openTablePanel("quotes");
    const selected = await panel.saveWorkspace();
    const shown = await panel.showTable("orders");
    return {
      closed,
      legacyClosed,
      selected,
      shown,
      afterShow: await panel.saveWorkspace(),
    };
  });
  expect(Object.keys(result.closed.panels)).toEqual(["orders"]);
  expect(result.closed.masters ?? []).toEqual([]);
  expect(result.closed.retained_panel_configs_by_table.quotes.table).toBe(
    "quotes",
  );
  expect(Object.keys(result.legacyClosed.panels)).toEqual(["orders"]);
  expect(Object.values(result.selected.panels).map((p) => p.table)).toEqual([
    "quotes",
  ]);
  expect(
    Object.values(result.afterShow.panels)
      .map((p) => p.table)
      .sort(),
  ).toEqual(["orders", "quotes"]);
  expect(result.afterShow.panels[result.shown].table).toBe("orders");
});

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
  expect(result.unknown).toBe("Unknown table: unknown");
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
  await page.getByLabel("Open table").selectOption("quotes");
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
  await page.getByRole("button", { name: "Close table panels" }).click();
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
  await page.getByLabel("Open table").selectOption("quotes");
  const switched = await page.evaluate(() =>
    document.querySelector("#workspace").saveClean(),
  );
  expect(Object.values(switched.panels).map((p) => p.table)).toEqual([
    "quotes",
  ]);
  expect(switched.closed_channels.orders.table).toBe("orders");
  await expect(page.locator("perspective-viewer-datagrid")).toHaveCount(1);
  await page.getByRole("button", { name: "Close table panels" }).click();
  expect(
    (await page.evaluate(() => document.querySelector("#workspace").save()))
      .panels,
  ).toEqual({});
  await page.getByLabel("Open table").selectOption("orders");
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
  await mountChannels(page);
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
      const converted = await migrateLayout(input);
      const saved = await panel.save();
      panel.config = { ...panel.config, layout: saved };
      return {
        converted,
        saved,
        roundtrip: await panel.save(),
        unchanged:
          JSON.stringify(await migrateLayout(converted)) ===
          JSON.stringify(converted),
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

test("information a layout upgrade would drop is rejected by pointer and the current layout stays", async ({
  page,
}) => {
  await mountChannels(page);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    const errors = [];
    panel.addEventListener("perspective-error", (event) =>
      errors.push(String(event.detail?.message ?? event.detail)),
    );
    const before = await panel.save();
    let rejected;
    try {
      panel.config = {
        ...panel.config,
        layout: {
          viewers: { grid: { table: "quotes", linked: true } },
          detail: {
            main: { type: "tab-area", widgets: ["grid"], currentIndex: 0 },
          },
          mode: "linked",
        },
      };
    } catch (error) {
      rejected = error.message;
    }
    const after = await panel.save();
    return {
      errors,
      rejected,
      same: JSON.stringify(after.panels) === JSON.stringify(before.panels),
    };
  });
  // the setter rejects it synchronously, before the viewer is touched
  expect(result.errors).toEqual([]);
  expect(result.rejected).toContain(
    "config.layout/mode: dropped by ws.drop_linked",
  );
  expect(result.rejected).toContain("config.layout/viewers/grid/linked");
  expect(result.same).toBe(true);
});

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
    expect(result.unknown).toBe("Unknown table: toString");
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
  // the viewer's own verdict on the plugin setting; the schema's on a patch that is no object
  expect(result.errors[2]).toContain("Invalid `plugin_config.edit_mode`");
  expect(result.errors[3]).toContain("config: invalid config at");
  expect(result.recovered.panels.second.filter).toEqual([
    ["symbol", "==", "AAPL"],
  ]);
});

test("showTable reuses a detail panel and replaces only supplied filter columns", async ({
  page,
}) => {
  await mountChannels(page, {
    layout: {
      layout: {
        type: "split-layout",
        orientation: "horizontal",
        sizes: [2, 5],
        children: [
          { type: "tab-layout", tabs: ["master"] },
          { type: "tab-layout", tabs: ["detail", "other"], selected: 1 },
        ],
      },
      masters: ["master"],
      panels: {
        master: { table: "quotes", plugin: "Datagrid", group_by: ["symbol"] },
        detail: {
          table: "quotes",
          plugin: "Datagrid",
          filter: [
            ["symbol", "==", "NVDA"],
            ["price", ">", 100],
            ["price", "<", 200],
          ],
        },
        other: { table: "quotes", plugin: "Datagrid", columns: ["price"] },
      },
    },
  });
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    const before = await panel.save();
    const plugins = [
      ...panel.viewer.querySelectorAll("perspective-viewer-datagrid"),
    ];
    const id = await panel.showTable("quotes", {
      filter: [
        ["price", ">=", 150],
        ["price", "<=", 220],
      ],
    });
    const filtered = await panel.save();
    await panel.showTable("quotes");
    await panel.showTable("quotes", { filter: [] });
    return {
      before,
      filtered,
      final: await panel.save(),
      id,
      initial: plugins.length,
      retained: plugins.filter((p) => p.isConnected).length,
    };
  });
  expect(result.id).toBe("detail");
  expect(result.filtered.panels.detail.filter).toEqual([
    ["symbol", "==", "NVDA"],
    ["price", ">=", 150],
    ["price", "<=", 220],
  ]);
  expect(result.filtered.panels.master).toEqual(result.before.panels.master);
  expect(result.filtered.panels.other).toEqual(result.before.panels.other);
  expect(result.filtered.layout.sizes).toEqual(result.before.layout.sizes);
  expect(result.filtered.layout.children[1].selected).toBe(0);
  expect(result.final).toEqual(result.filtered);
  expect(result.retained).toBe(result.initial);
});

test("showTable opens a configured detail beside a same-table master without replacing panels", async ({
  page,
}) => {
  await mountChannels(page, {
    single_tab: true,
    channels: {
      quotes: { columns: ["price"], filter: [["price", ">", 100]] },
      orders: {},
    },
    layout: {
      layout: {
        type: "split-layout",
        orientation: "horizontal",
        sizes: [1, 4],
        children: [
          { type: "tab-layout", tabs: ["master"] },
          { type: "tab-layout", tabs: ["channel:quotes"] },
        ],
      },
      masters: ["master"],
      panels: {
        master: { table: "quotes", plugin: "Datagrid", group_by: ["symbol"] },
        "channel:quotes": { table: "orders", plugin: "Datagrid" },
      },
    },
  });
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    const before = await panel.save();
    const plugins = [
      ...panel.viewer.querySelectorAll("perspective-viewer-datagrid"),
    ];
    const id = await panel.showTable("quotes", {
      filter: [["symbol", "==", "AAPL"]],
    });
    const again = await panel.showTable("quotes");
    return {
      before,
      saved: await panel.save(),
      id,
      again,
      retained: plugins.filter((p) => p.isConnected).length,
    };
  });
  expect(result.id).toBe("channel:quotes:");
  expect(result.again).toBe(result.id);
  for (const id of Object.keys(result.before.panels))
    expect(result.saved.panels[id]).toEqual(result.before.panels[id]);
  expect(result.saved.panels[result.id]).toMatchObject({
    table: "quotes",
    columns: ["price"],
    group_by: [],
    filter: [
      ["price", ">", 100],
      ["symbol", "==", "AAPL"],
    ],
    theme: "Pro Dark",
  });
  expect(result.saved.layout.sizes).toEqual(result.before.layout.sizes);
  expect(result.saved.layout.children[1]).toMatchObject({
    tabs: ["channel:quotes", result.id],
    selected: 1,
  });
  expect(result.saved.masters).toEqual(["master"]);
  expect(result.retained).toBe(2);
});

test("showTable queues behind layout changes, snapshots options, and recovers from invalid calls", async ({
  page,
}) => {
  await mountChannels(page);
  const result = await page.evaluate(async () => {
    const panel = document.querySelector("#workspace");
    panel.config = {
      ...panel.config,
      layout: {
        layout: { type: "tab-layout", tabs: ["renamed"] },
        panels: { renamed: { table: "quotes", plugin: "Datagrid" } },
      },
    };
    const options = { filter: [["symbol", "==", "NVDA"]] };
    const first = panel.showTable("quotes", options);
    options.filter[0][2] = "AAPL";
    const second = panel.showTable("quotes", {
      filter: [["price", ">", 100]],
    });
    const ids = await Promise.all([first, second]);
    const saved = await panel.save();
    const errors = [];
    for (const [name, options] of [
      ["unknown", {}],
      ["toString", {}],
      ["quotes", null],
      ["quotes", { filter: "bad" }],
      ["quotes", { filter: [[]] }],
      ["orders", { filter: [["missing", "==", 1]] }],
    ]) {
      try {
        await panel.showTable(name, options);
      } catch (e) {
        errors.push(String(e));
      }
    }
    const afterErrors = await panel.save();
    const id = await panel.showTable("orders");
    return {
      ids,
      saved,
      errors,
      afterErrors,
      id,
      recovered: await panel.save(),
    };
  });
  expect(result.ids).toEqual(["renamed", "renamed"]);
  expect(result.saved.panels.renamed.filter).toEqual([
    ["symbol", "==", "NVDA"],
    ["price", ">", 100],
  ]);
  expect(result.errors).toHaveLength(6);
  expect(result.errors[0]).toContain("Unknown table: unknown");
  expect(result.errors[1]).toContain("Unknown table: toString");
  expect(result.afterErrors).toEqual(result.saved);
  expect(result.recovered.panels[result.id].table).toBe("orders");
});

for (const mastersOnly of [false, true]) {
  test(`showTable creates a detail in ${mastersOnly ? "a master-only" : "an empty"} workspace`, async ({
    page,
  }) => {
    const masterLayout = {
      type: "split-layout",
      orientation: "vertical",
      sizes: [2, 3],
      children: [
        { type: "tab-layout", tabs: ["master-one"] },
        { type: "tab-layout", tabs: ["master-two"] },
      ],
    };
    await mountChannels(page, {
      tables: ["quotes"],
      channels: {},
      layout: mastersOnly
        ? {
            layout: masterLayout,
            masters: ["master-one", "master-two"],
            panels: {
              "master-one": { table: "quotes", plugin: "Datagrid" },
              "master-two": {
                table: "quotes",
                plugin: "Datagrid",
                group_by: ["symbol"],
              },
            },
          }
        : { panels: {}, layout: null },
    });
    const result = await page.evaluate(async () => {
      const panel = document.querySelector("#workspace");
      const before = await panel.save();
      const plugins = [
        ...panel.viewer.querySelectorAll("perspective-viewer-datagrid"),
      ];
      const id = await panel.showTable("quotes", {
        filter: [["price", ">", 190]],
      });
      return {
        id,
        before,
        saved: await panel.save(),
        retained: plugins.filter((p) => p.isConnected).length,
      };
    });
    expect(result.saved.panels[result.id]).toMatchObject({
      table: "quotes",
      filter: [["price", ">", 190]],
    });
    expect(result.saved.masters ?? []).not.toContain(result.id);
    if (mastersOnly) {
      expect(result.saved.layout.children[0]).toEqual(result.before.layout);
      for (const id of result.saved.masters)
        expect(result.saved.panels[id]).toEqual(result.before.panels[id]);
      expect(result.retained).toBe(2);
    } else expect(result.saved.layout.tabs).toEqual([result.id]);
  });
}
