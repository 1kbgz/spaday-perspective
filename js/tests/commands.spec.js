import { expect, test } from "@playwright/test";

// `setCommandSchema` is the viewer's own; these check the panel hands it through, holds a schema
// set before it connects, re-dispatches `perspective-command` and supplies its icon masks.
async function mount(page, { early = true, panel = {} } = {}) {
  // a schema or resolver failure aborts the grid's draw and is only logged; surface it
  const logged = [];
  page.on("pageerror", (error) => logged.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") logged.push(message.text());
  });
  await page.goto("/dist/index.html");
  await page.evaluate(
    async ({ early, panel: extra }) => {
      const client = await globalThis.__spadayPerspective.worker();
      await client.table(
        [
          { id: 1, region: "east", value: 10 },
          { id: 2, region: "west", value: 20 },
        ],
        { name: "rows", index: "id" },
      );
      await client.table([{ a: "x", b: "y", value: 1 }], {
        name: "pair",
        index: ["a", "b"],
      });
      // a schema is a function, so the tests name one by its commands
      window.schema = (commands) => () => ({ commands });
      window.OPEN = [{ kind: "Command", key: "open", label: "Open" }];
      const panel = document.createElement("perspective-panel");
      panel.id = "commands";
      panel.style.cssText = "width:700px;height:300px";
      const set = () =>
        panel.setCommandSchema(window.schema(window.OPEN), {
          scopes: ["datagrid-row"],
        });
      if (early) await set();
      panel.config = {
        local: true,
        layout: {
          panels: {
            main: {
              table: "rows",
              columns: ["id", "region", "value"],
              ...extra,
            },
          },
          layout: { type: "tab-layout", tabs: ["main"] },
        },
      };
      window.commands = [];
      panel.addEventListener("perspective-command", (event) =>
        window.commands.push(event.detail),
      );
      document.body.append(panel);
      await panel.save();
      if (!early) await set();
    },
    { early, panel },
  );
  const cells = page.locator("#commands regular-table tbody td");
  await expect
    .poll(async () => logged.length + (await cells.count()))
    .toBeGreaterThan(0);
  expect(logged).toEqual([]);
  await expect(cells.first()).toBeVisible();
}

const button = (page, name) =>
  page.locator("#commands").getByRole("button", { name, exact: true });

for (const early of [true, false]) {
  test(`a schema set ${early ? "before connecting" : "after loading"} draws its row buttons`, async ({
    page,
  }) => {
    await mount(page, { early });
    await expect(button(page, "Open")).toHaveCount(2);
  });
}

test("picking a command re-dispatches perspective-command with its context", async ({
  page,
}) => {
  await mount(page);
  await button(page, "Open").first().click();
  await expect.poll(() => page.evaluate(() => window.commands.length)).toBe(1);
  const detail = await page.evaluate(() => window.commands[0]);
  expect(detail.key).toBe("open");
  expect(detail.context).toEqual(
    expect.objectContaining({
      location: "datagrid-row",
      panel: "main",
      table: "rows",
      plugin: "Datagrid",
    }),
  );
  expect(detail.context.hit).toEqual(
    expect.objectContaining({ kind: "row", id: [1], row_path: [] }),
  );
});

test("a composite index's row id is its key tuple", async ({ page }) => {
  await mount(page, { panel: { table: "pair", columns: ["a", "b", "value"] } });
  await button(page, "Open").first().click();
  await expect.poll(() => page.evaluate(() => window.commands.length)).toBe(1);
  expect(await page.evaluate(() => window.commands[0].context.hit)).toEqual(
    expect.objectContaining({ kind: "row", id: ["x", "y"], row_path: [] }),
  );
});

// The Datagrid only accepts `command_column` once it has drawn with the row scope declared, so
// Perspective drops it from the workspace a page loads with, however early the schema is set.
test("command_column applies once the grid has drawn with the scope", async ({
  page,
}) => {
  await mount(page);
  await expect(button(page, "Open")).toHaveCount(2);
  await page.evaluate(() =>
    document
      .querySelector("#commands")
      .restorePanel("main", { plugin_config: { command_column: "right" } }),
  );
  // the grid lives in the datagrid's shadow root, so walk from a button rather than the document
  await expect
    .poll(() =>
      button(page, "Open")
        .first()
        .evaluate((open) => open.closest("tr").lastElementChild.contains(open)),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      async () =>
        (await document.querySelector("#commands").save()).panels.main
          .plugin_config.command_column,
    ),
  ).toBe("right");
});

test("a new schema replaces the old, reconnecting keeps it, and null removes it", async ({
  page,
}) => {
  await mount(page);
  await expect(button(page, "Open")).toHaveCount(2);
  await page.evaluate(() =>
    document
      .querySelector("#commands")
      .setCommandSchema(
        window.schema([{ kind: "Command", key: "later", label: "Later" }]),
        { scopes: ["datagrid-row"] },
      ),
  );
  await expect(button(page, "Later")).toHaveCount(2);
  await expect(button(page, "Open")).toHaveCount(0);
  await page.evaluate(async () => {
    const panel = document.querySelector("#commands");
    panel.remove();
    document.body.append(panel);
    await panel.save();
  });
  await expect(button(page, "Later")).toHaveCount(2);
  await page.evaluate(() =>
    document.querySelector("#commands").setCommandSchema(null),
  );
  await expect(page.locator("#commands .psp-command-button")).toHaveCount(0);
});

test("the panel's icon masks reach an icon-only button", async ({ page }) => {
  await mount(page);
  await page.evaluate(() =>
    document.querySelector("#commands").setCommandSchema(
      window.schema([
        {
          kind: "Command",
          key: "delete",
          label: "",
          icon: "delete",
          title: "Delete row",
        },
      ]),
      { scopes: ["datagrid-row"] },
    ),
  );
  const remove = button(page, "Delete row").first();
  await expect(remove).toBeVisible();
  expect(
    await remove.evaluate((element) => ({
      text: element.textContent,
      icon: element.dataset.icon,
      mask: getComputedStyle(element).getPropertyValue(
        "--psp-command-button--mask-image",
      ),
    })),
  ).toEqual({
    text: "",
    icon: "delete",
    mask: expect.stringContaining("data:image/svg+xml"),
  });
});

test("the Python example's icon buttons copy and delete through perspective-command", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8015");
  const copied = page.waitForResponse((response) =>
    response.url().endsWith("/api/trades/copy"),
  );
  await page
    .getByRole("button", { name: "Copy trade to form", exact: true })
    .first()
    .click();
  const trade = await (await copied).json();
  await expect(page.getByLabel("Symbol", { exact: true })).toHaveValue(
    trade.symbol,
  );
  await expect(page.locator(".order-status")).toHaveText(trade.message);
  await page
    .getByRole("button", { name: "Delete trade", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Delete trade?" });
  await expect(dialog).toBeVisible();
  const deleted = page.waitForResponse((response) =>
    response.url().endsWith("/api/trades/delete"),
  );
  await dialog
    .getByRole("button", { name: "Delete trade", exact: true })
    .click();
  expect((await deleted).status()).toBe(200);
  // the grouped view is of groups, not trades, so it offers no row commands
  await page
    .getByRole("button", { name: "Group by symbol", exact: true })
    .click();
  await expect(
    page.locator("#market-grid regular-table tbody th").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete trade", exact: true }),
  ).toHaveCount(0);
});
