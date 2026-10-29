import { expect, test } from "@playwright/test";

test("Python computed labels update existing action buttons through the store", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8016");
  await expect(
    page.getByRole("button", { name: "Copy position", exact: true }),
  ).toHaveCount(3);
  await page.locator("#rename-action").click();
  await expect(
    page.getByRole("button", { name: "Copy to portfolio", exact: true }),
  ).toHaveCount(3);
});

async function mount(page, options = {}) {
  await page.goto("/dist/index.html");
  await page.evaluate(async (options) => {
    const client = await globalThis.__spadayPerspective.worker();
    const table = await client.table(
      [
        { id: "a", value: 10 },
        { id: "b", value: 20 },
      ],
      { name: "rows", ...(!options.unindexed && { index: "id" }) },
    );
    const panel = document.createElement("perspective-panel");
    panel.id = "actions";
    panel.style.cssText = "width:800px;height:400px";
    panel.rowActions = {
      rows: {
        "@copy": {
          header: "Copy",
          position: "start",
          buttons: [{ action: "copy", label: "Copy row", icon: "copy" }],
        },
        "@delete": {
          header: "Delete",
          position: "end",
          buttons: [{ action: "delete", label: "Delete row", icon: "delete" }],
        },
      },
    };
    panel.config = {
      local: true,
      layout: {
        panels: {
          main: { table: "rows", columns: ["id", "value"], ...options.config },
        },
        layout: { type: "tab-layout", tabs: ["main"] },
      },
    };
    window.actionTest = { panel, table, events: [], errors: [] };
    panel.addEventListener("perspective-row-action", (e) =>
      window.actionTest.events.push(e.detail),
    );
    panel.addEventListener("perspective-error", (e) =>
      window.actionTest.errors.push(String(e.detail)),
    );
    document.body.append(panel);
    await panel.save();
  }, options);
}

test("dedicated columns retain data and typed keys through sorting, filtering and save", async ({
  page,
}) => {
  await mount(page);
  await expect(page.getByRole("button", { name: "Copy row" })).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      actionTest.panel.viewer.getViewConfig({ panel: "main" }),
    ),
  ).toMatchObject({ columns: ["Copy", "id", "value", "Delete"] });
  await page.evaluate(() =>
    actionTest.panel.viewer.restore(
      { sort: [["value", "desc"]] },
      { panel: "main" },
    ),
  );
  await page.getByRole("button", { name: "Copy row" }).first().click();
  expect(await page.evaluate(() => actionTest.events)).toEqual([
    { action: "copy", panel: "main", table: "rows", column: "@copy", key: "b" },
  ]);
  expect(await page.evaluate(() => actionTest.table.size())).toBe(2);
  expect(await page.evaluate(() => actionTest.panel.save())).toMatchObject({
    panels: { main: { columns: ["id", "value"], expressions: {} } },
  });
  await page.evaluate(async () => {
    const p = actionTest.panel;
    p.config = { ...p.config, layout: await p.save() };
    await p.save();
    await p.viewer.restore({ filter: [["id", "==", "a"]] }, { panel: "main" });
  });
  await expect(page.getByRole("button", { name: "Delete row" })).toHaveCount(1);
  await page.getByRole("button", { name: "Delete row" }).click();
  expect(await page.evaluate(() => actionTest.events.at(-1))).toMatchObject({
    key: "a",
    column: "@delete",
  });
  expect(await page.locator("regular-table td").allTextContents()).toContain(
    "a",
  );
  expect(await page.evaluate(() => actionTest.errors)).toEqual([]);
});

test("reactive policies update labels and remove generated columns without changing data", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const p = actionTest.panel;
    const actions = structuredClone(p.rowActions);
    actions.rows["@copy"].buttons[0].label = "Copy to portfolio";
    p.rowActions = actions;
  });
  await expect(
    page.getByRole("button", { name: "Copy to portfolio" }),
  ).toHaveCount(2);
  await page.evaluate(async () => {
    actionTest.panel.rowActions = {};
    await actionTest.panel.save();
  });
  await expect(page.getByRole("button", { name: "Delete row" })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      actionTest.panel.viewer.getViewConfig({ panel: "main" }),
    ),
  ).toMatchObject({ columns: ["id", "value"], expressions: {} });
  expect(await page.evaluate(() => actionTest.table.schema())).toEqual({
    id: "string",
    value: "integer",
  });
});

for (const options of [
  { unindexed: true },
  { config: { group_by: ["id"] } },
  { config: { split_by: ["id"] } },
]) {
  test(`unsafe action rows are disabled: ${JSON.stringify(options)}`, async ({
    page,
  }) => {
    await mount(page, options);
    await expect(
      page.getByRole("button", { name: "Delete row" }).first(),
    ).toBeDisabled();
  });
}

test("real column collisions are reported without overwriting columns", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    actionTest.panel.rowActions = {
      rows: {
        "@bad": {
          header: "id",
          position: "start",
          buttons: [{ action: "x", label: "X" }],
        },
      },
    };
    await actionTest.panel.save().catch(() => {});
  });
  expect(
    await page.evaluate(() =>
      actionTest.errors.some((e) => e.includes("conflicts")),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => actionTest.table.schema())).toEqual({
    id: "string",
    value: "integer",
  });
});

test("multiple columns per position, multiple icons, reconnect, and channel reopening", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const p = actionTest.panel;
    p.rowActions = {
      rows: {
        ...p.rowActions.rows,
        "@extra": {
          header: "More",
          position: "start",
          buttons: [
            { action: "add", label: "Add row", icon: "add" },
            { action: "copy", label: "Copy again", icon: "copy", text: "Copy" },
          ],
        },
      },
    };
    p.config = {
      ...p.config,
      channels: { rows: { columns: ["id", "value"] } },
    };
    await p.save();
  });
  expect(
    await page.evaluate(() =>
      actionTest.panel.viewer.getViewConfig({ panel: "main" }),
    ),
  ).toMatchObject({ columns: ["Copy", "More", "id", "value", "Delete"] });
  await expect(
    page.getByRole("button", { name: "Copy again" }).first().locator("svg"),
  ).toHaveAttribute("aria-hidden", "true");
  await page.getByRole("button", { name: "Add row" }).first().focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => actionTest.events.at(-1))).toMatchObject({
    action: "add",
    column: "@extra",
    key: "a",
  });
  await page.evaluate(async () => {
    const p = actionTest.panel;
    p.remove();
    document.body.append(p);
    await p.save();
  });
  await expect(page.getByRole("button", { name: "Copy again" })).toHaveCount(2);
  await page.evaluate(async () => {
    const p = actionTest.panel;
    await p.closeChannel("rows");
    await p.openChannel("rows");
    await p.save();
  });
  await expect(page.getByRole("button", { name: "Copy again" })).toHaveCount(2);
  expect(await page.evaluate(() => actionTest.errors)).toEqual([]);
});

test("invalid policies are rejected atomically", async ({ page }) => {
  await mount(page);
  const errors = await page.evaluate(() => {
    const p = actionTest.panel,
      before = JSON.stringify(p.rowActions);
    return [
      { rows: { "@x": { header: "", position: "start", buttons: [] } } },
      { rows: { "@x": { header: "X", position: "middle", buttons: [] } } },
      {
        rows: {
          "@x": {
            header: "X",
            position: "end",
            buttons: [{ action: "x", label: "X", icon: "unknown" }],
          },
        },
      },
      {
        rows: {
          "@x": { header: "X", position: "end", buttons: [] },
          "@y": { header: "X", position: "start", buttons: [] },
        },
      },
    ].map((policy) => {
      try {
        p.rowActions = policy;
        return false;
      } catch {
        return before === JSON.stringify(p.rowActions);
      }
    });
  });
  expect(errors).toEqual([true, true, true, true]);
});
