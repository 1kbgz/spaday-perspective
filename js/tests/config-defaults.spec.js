import { expect, test } from "@playwright/test";

test("defaults merge by scope, remove with null, and are shared across wrappers", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  const result = await page.evaluate(async () => {
    await customElements.whenDefined("perspective-panel");
    const first = document.createElement("perspective-panel");
    const second = document.createElement("perspective-panel");
    await first.setPluginConfigDefaults({ group_pad: 10 });
    await first.setPluginConfigDefaults(
      { scroll_lock: true },
      { plugin: "Datagrid" },
    );
    await first.setColumnConfigDefaults(
      { date_format: { timeZone: "UTC", hour12: false } },
      { type: "datetime" },
    );
    await first.setColumnConfigDefaults(
      { date_format: { hour12: null } },
      { type: "datetime" },
    );
    await first.setColumnConfigDefaults(
      { number_format: { maximumFractionDigits: 4 } },
      { plugin: "Datagrid", type: "float" },
    );
    const plugin = await second.getPluginConfigDefaults();
    const column = await second.getColumnConfigDefaults();
    await second.setPluginConfigDefaults({ group_pad: null });
    await second.setPluginConfigDefaults(null, { plugin: "Datagrid" });
    await second.setColumnConfigDefaults(null, { type: "datetime" });
    await second.setColumnConfigDefaults(null, {
      plugin: "Datagrid",
      type: "float",
    });
    return {
      plugin,
      column,
      cleared: [
        await first.getPluginConfigDefaults(),
        await first.getColumnConfigDefaults(),
      ],
    };
  });
  expect(result.plugin).toEqual(
    expect.arrayContaining([
      { defaults: { group_pad: 10 } },
      { plugin: "Datagrid", defaults: { scroll_lock: true } },
    ]),
  );
  expect(result.column).toEqual(
    expect.arrayContaining([
      { type: "datetime", defaults: { date_format: { timeZone: "UTC" } } },
      {
        plugin: "Datagrid",
        type: "float",
        defaults: { number_format: { maximumFractionDigits: 4 } },
      },
    ]),
  );
  expect(result.cleared).toEqual([[], []]);
});

test("defaults validate upstream, recover after errors, and are omitted from saved workspaces", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  const result = await page.evaluate(async () => {
    await customElements.whenDefined("perspective-panel");
    const panel = document.createElement("perspective-panel");
    const errors = [];
    for (const [method, defaults, options] of [
      ["setPluginConfigDefaults", [], {}],
      ["setPluginConfigDefaults", {}, { plugin: "Missing plugin" }],
      ["setColumnConfigDefaults", {}, { type: "invalid" }],
      [
        "setColumnConfigDefaults",
        { date_format: { dateStyle: "long", year: "numeric" } },
        {},
      ],
    ]) {
      try {
        await panel[method](defaults, options);
      } catch (error) {
        errors.push(String(error));
      }
    }
    await panel.setPluginConfigDefaults(
      { scroll_lock: false },
      { plugin: "Datagrid" },
    );
    await panel.setColumnConfigDefaults(
      { number_format: { maximumFractionDigits: 4 } },
      { plugin: "Datagrid", type: "float" },
    );
    const worker = await globalThis.__spadayPerspective.worker();
    await worker.table([{ price: 1.23456 }], { name: "defaults" });
    panel.config = {
      local: true,
      workspace: {
        layout: { type: "tab-layout", tabs: ["grid"] },
        panels: {
          grid: {
            table: "defaults",
            plugin: "Datagrid",
            plugin_config: { scroll_lock: false },
            columns_config: {
              price: { number_format: { maximumFractionDigits: 4 } },
            },
          },
        },
      },
    };
    panel.style.height = "400px";
    document.body.append(panel);
    const saved = await panel.saveWorkspace();
    const config = Object.values(saved.panels)[0];
    const defaults = await panel.getColumnConfigDefaults();
    return { errors, config, defaults };
  });
  expect(result.errors).toHaveLength(4);
  expect(result.config.plugin_config).not.toHaveProperty("scroll_lock");
  expect(result.config.columns_config?.price?.number_format).toBeUndefined();
  expect(result.defaults).toHaveLength(1);
  await expect(page.locator("regular-table")).toContainText("1.2346");
});
