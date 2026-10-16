import { expect, test } from "@playwright/test";

test("row action configuration rejects malformed mappings", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  const errors = await page.evaluate(() => {
    const panel = document.createElement("perspective-panel");
    return [[], 42, { rows: [] }, { rows: null }, { rows: { id: {} } }].map(
      (value) => {
        try {
          panel.rowActions = value;
          return null;
        } catch (error) {
          return error.name;
        }
      },
    );
  });
  expect(errors).toEqual(Array(5).fill("TypeError"));
});

test("main example deletes a trade through its Python endpoint", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8015");
  const deleted = page.waitForResponse((response) =>
    response.url().endsWith("/api/trades/delete"),
  );
  await page
    .getByRole("button", { name: "Delete trade", exact: true })
    .first()
    .click();
  const response = await deleted;
  expect(response.status()).toBe(200);
  const key = response.request().postDataJSON().id;
  await expect(page.locator(".order-status")).toHaveText(
    `Deleted trade ${key}`,
  );
  await expect
    .poll(() =>
      page.evaluate(async (key) => {
        const panel = document.querySelector("perspective-panel");
        const table = await panel.viewer.getTable({ wait: false });
        const view = await table.view({ filter: [["id", "==", key]] });
        try {
          return await view.to_json();
        } finally {
          await view.delete();
        }
      }, key),
    )
    .toEqual([]);
});

test("Python row actions delete through the server and update two browsers", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const other = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await Promise.all([
      page.goto("http://127.0.0.1:8017"),
      other.goto("http://127.0.0.1:8017"),
    ]);
    const buttons = page.getByRole("button", {
      name: "Delete order",
      exact: true,
    });
    await expect(buttons).toHaveCount(3);
    await expect(
      other.getByRole("button", { name: "Delete order", exact: true }),
    ).toHaveCount(3);
    await buttons.first().click();
    await expect(page.getByRole("status")).toHaveText("Deleted order 1");
    for (const tab of [page, other]) {
      await expect(tab.locator("perspective-panel")).not.toContainText(
        "First order",
      );
      await expect(
        tab.getByRole("button", { name: "Delete order", exact: true }),
      ).toHaveCount(2);
    }
    await buttons.last().click();
    await expect(page.getByRole("status")).toHaveText(
      "Locked orders cannot be deleted",
    );
    await expect(buttons).toHaveCount(2);
    await buttons.first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("Deleted order 2");
    await expect(
      other.getByRole("button", { name: "Delete order", exact: true }),
    ).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await other.close();
  }
});

async function prepare(page) {
  await page.goto("/dist/index.html");
  await page.evaluate(async () => {
    const worker = await globalThis.__spadayPerspective.worker();
    const table = await worker.table(
      [
        { id: "a", value: 1, group: "same" },
        { id: "b", value: 2, group: "same" },
        { id: "c", value: 3, group: "same" },
      ],
      { name: "rows", index: "id" },
    );
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "height:300px;width:600px";
    panel.rowActions = {
      rows: { id: { action: "inspect", label: "Inspect row" } },
    };
    panel.config = {
      local: true,
      layout: {
        layout: { type: "tab-layout", tabs: ["rows"] },
        panels: {
          rows: {
            table: "rows",
            plugin: "Datagrid",
            columns: ["id", "value", "group"],
          },
        },
      },
    };
    window.rowTest = { panel, table, events: [], clicks: [] };
    panel.addEventListener("perspective-row-action", (e) =>
      window.rowTest.events.push(e.detail),
    );
    panel.addEventListener("perspective-click", (e) =>
      window.rowTest.clicks.push(e.detail),
    );
    document.body.append(panel);
  });
  await expect(
    page.getByRole("button", { name: "Inspect row", exact: true }),
  ).toHaveCount(3);
}

test("row actions retain typed keys after sorting and do not mutate data or select cells", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({ sort: [["value", "desc"]] }),
  );
  const buttons = page.getByRole("button", {
    name: "Inspect row",
    exact: true,
  });
  await buttons.first().click();
  await expect
    .poll(() => page.evaluate(() => window.rowTest.events))
    .toEqual([
      {
        action: "inspect",
        panel: expect.any(String),
        table: "rows",
        column: "id",
        key: "c",
      },
    ]);
  expect(await page.evaluate(() => window.rowTest.table.size())).toBe(3);
  expect(await page.evaluate(() => window.rowTest.clicks)).toEqual([]);
  await buttons.nth(1).focus();
  await page.keyboard.press("Space");
  await expect
    .poll(() => page.evaluate(() => window.rowTest.events.map((e) => e.key)))
    .toEqual(["c", "b"]);
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({ filter: [["id", "==", "a"]] }),
  );
  await expect(buttons).toHaveCount(1);
  await buttons.click();
  await expect
    .poll(() => page.evaluate(() => window.rowTest.events.map((e) => e.key)))
    .toEqual(["c", "b", "a"]);
});

test("grouped actions are disabled and removing annotations restores cells", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({ group_by: ["group"] }),
  );
  const buttons = page.getByRole("button", {
    name: "Inspect row",
    exact: true,
  });
  await expect(buttons.first()).toBeDisabled();
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({ group_by: [] }),
  );
  await expect(buttons.first()).toBeEnabled();
  await page.evaluate(() => {
    window.rowTest.panel.rowActions = {};
  });
  await expect(buttons).toHaveCount(0);
  await expect(page.locator("perspective-panel")).toContainText("a");
  await page.evaluate(() => {
    const { panel } = window.rowTest;
    panel.remove();
    panel.rowActions = {
      rows: { id: { action: "inspect", label: "Inspect row" } },
    };
    document.body.append(panel);
  });
  await expect(buttons).toHaveCount(3);
  await buttons.first().click();
  await expect
    .poll(() => page.evaluate(() => window.rowTest.events.length))
    .toBe(1);
});

test("a recycled cell cancels an in-progress pointer action", async ({
  page,
}) => {
  await prepare(page);
  const buttons = page.getByRole("button", {
    name: "Inspect row",
    exact: true,
  });
  const box = await buttons.first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({ sort: [["value", "desc"]] }),
  );
  await page.mouse.up();
  expect(await page.evaluate(() => window.rowTest.events)).toEqual([]);
  await buttons.first().click();
  await expect
    .poll(() => page.evaluate(() => window.rowTest.events.map((e) => e.key)))
    .toEqual(["c"]);
});

test("row actions follow column and plugin changes without duplicate handlers", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() => {
    window.rowTest.errors = [];
    window.rowTest.panel.addEventListener("perspective-error", (event) =>
      window.rowTest.errors.push(String(event.detail)),
    );
  });
  const buttons = page.getByRole("button", {
    name: "Inspect row",
    exact: true,
  });
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({ columns: ["value", "id"] }),
  );
  await buttons.first().click();
  await expect
    .poll(() => page.evaluate(() => window.rowTest.events.map((e) => e.key)))
    .toEqual(["a"]);
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({ columns: ["value"] }),
  );
  await expect(buttons).toHaveCount(0);
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({
      plugin: "Y Bar",
      columns: ["value"],
    }),
  );
  await expect(buttons).toHaveCount(0);
  await page.evaluate(() =>
    window.rowTest.panel.viewer.restore({
      plugin: "Datagrid",
      columns: ["id", "value"],
    }),
  );
  await expect(buttons).toHaveCount(3);
  await buttons.first().click();
  await expect
    .poll(() => page.evaluate(() => window.rowTest.events.map((e) => e.key)))
    .toEqual(["a", "a"]);
  expect(await page.evaluate(() => window.rowTest.errors)).toEqual([]);
});

test("row actions identify their panel across split layouts and restoration", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(async () => {
    const { panel } = window.rowTest;
    panel.style.width = "1000px";
    panel.config = {
      ...panel.config,
      layout: {
        layout: {
          type: "split-layout",
          orientation: "horizontal",
          sizes: [1, 1],
          children: [
            { type: "tab-layout", tabs: ["first"] },
            { type: "tab-layout", tabs: ["second"] },
          ],
        },
        panels: {
          first: {
            table: "rows",
            plugin: "Datagrid",
            columns: ["id", "value"],
          },
          second: {
            table: "rows",
            plugin: "Datagrid",
            columns: ["id", "value"],
            sort: [["value", "desc"]],
          },
        },
      },
    };
    await panel.save();
  });
  const grids = page.locator("perspective-viewer-datagrid");
  await expect(grids).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await grids
      .nth(i)
      .getByRole("button", { name: "Inspect row", exact: true })
      .first()
      .click();
  }
  const events = await page.evaluate(() => window.rowTest.events);
  expect(events.map((e) => e.key).sort()).toEqual(["a", "c"]);
  expect(new Set(events.map((e) => e.panel)).size).toBe(2);
  await page.evaluate(async () => {
    const { panel } = window.rowTest;
    const layout = await panel.save();
    panel.config = { ...panel.config, layout };
    await panel.save();
    window.rowTest.events = [];
  });
  await grids
    .first()
    .getByRole("button", { name: "Inspect row", exact: true })
    .first()
    .click();
  await expect
    .poll(() => page.evaluate(() => window.rowTest.events.length))
    .toBe(1);
});

test("non-index column buttons are disabled", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    window.rowTest.panel.rowActions = {
      rows: { value: { action: "delete", label: "Delete row" } },
    };
  });
  const buttons = page.getByRole("button", { name: "Delete row", exact: true });
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  expect(await page.evaluate(() => window.rowTest.events)).toEqual([]);
});
