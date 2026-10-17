import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`example toolbar controls fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("http://127.0.0.1:8015");
    const bar = page.locator(".perspective-panel-titlebar");
    await expect(
      bar.getByRole("button", { name: "Find", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        bar.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const controls = [...element.querySelectorAll("select,button")].map(
            (control) => control.getBoundingClientRect(),
          );
          const viewer = element.nextElementSibling.getBoundingClientRect();
          const panel = element.parentElement.getBoundingClientRect();
          return (
            controls.every(
              (control) =>
                control.top >= bounds.top &&
                control.bottom <= bounds.bottom &&
                control.left >= bounds.left &&
                control.right <= bounds.right &&
                Math.abs(control.height - controls[0].height) < 1,
            ) &&
            viewer.top >= bounds.bottom &&
            Math.abs(viewer.bottom - panel.bottom) < 2
          );
        }),
      )
      .toBe(true);
    for (const button of await bar.getByRole("button").all())
      await expect(button).toHaveCSS("white-space", "nowrap");
    if (width === 390) {
      const picker = await bar.getByRole("combobox").boundingBox();
      const find = await bar
        .getByRole("button", { name: "Find", exact: true })
        .boundingBox();
      expect(find.y).toBeGreaterThan(picker.y);
    }
  });
}

async function mount(page, options = {}) {
  await page.goto("/dist/index.html");
  await page.evaluate(async (options) => {
    const worker = await globalThis.__spadayPerspective.worker();
    const table = await worker.table(
      {
        id: "integer",
        name: "string",
        amount: "float",
        enabled: "boolean",
        group: "string",
        day: "date",
      },
      { name: "records", index: "id" },
    );
    await table.update([
      {
        id: 1,
        name: "Alpha",
        amount: 1.25,
        enabled: true,
        group: "keep",
        day: new Date("2026-10-01"),
      },
      {
        id: 2,
        name: "Beta",
        amount: 2.5,
        enabled: false,
        group: "keep",
        day: new Date("2026-10-02"),
      },
      {
        id: 3,
        name: "Alpha",
        amount: 3,
        enabled: true,
        group: "exclude",
        day: new Date("2026-10-03"),
      },
    ]);
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "display:block;height:350px;width:800px";
    panel.toolbar = true;
    panel.find = options.enabled ?? true;
    panel.config = {
      local: true,
      layout: {
        layout: { type: "tab-layout", tabs: ["grid"] },
        panels: {
          grid: {
            table: "records",
            plugin: "Datagrid",
            columns: ["id", "name", "amount", "enabled", "day"],
            filter: [["group", "==", "keep"]],
            plugin_config: { edit_mode: "SELECT_REGION" },
          },
        },
      },
    };
    document.body.append(panel);
    window.findTest = { panel, table };
    await panel.save();
  }, options);
  await expect(page.locator("regular-table tbody td").first()).toBeVisible();
}

async function filters(page) {
  return page.evaluate(async () => {
    const saved = await window.findTest.panel.save();
    return Object.values(saved.panels)[0].filter;
  });
}

for (const shortcut of ["Control+f", "Meta+f"]) {
  test(`${shortcut} filters the selected column while retaining existing filters`, async ({
    page,
  }) => {
    await mount(page);
    await page.locator("regular-table tbody td").nth(1).click();
    await page.keyboard.press(shortcut);
    const dialog = page.getByRole("dialog", { name: "Find in column" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Column")).toHaveValue("name");
    await expect(dialog.getByLabel("Equals")).toBeFocused();
    await dialog.getByLabel("Equals").fill("Alpha");
    await dialog.getByRole("button", { name: "Apply filter" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await filters(page)).toEqual([
      ["group", "==", "keep"],
      ["name", "==", "Alpha"],
    ]);
    await expect(page.locator("regular-table tbody tr")).toHaveCount(1);
  });
}

for (const [column, raw, expected] of [
  ["id", "2", 2],
  ["amount", "2.5", 2.5],
  ["enabled", "false", false],
  ["day", "2026-10-02", Date.parse("2026-10-02")],
  ["name", "missing", "missing"],
]) {
  test(`Find applies a typed ${column} filter`, async ({ page }) => {
    await mount(page);
    await page.getByRole("button", { name: "Find", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Column").selectOption(column);
    await dialog.getByLabel("Equals").fill(raw);
    await dialog.getByRole("button", { name: "Apply filter" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await filters(page)).at(-1)).toEqual([column, "==", expected]);
    await expect(page.locator("regular-table tbody tr")).toHaveCount(
      column === "name" ? 0 : 1,
    );
  });
}

test("Find validates values and cancels without changing filters", async ({
  page,
}) => {
  await mount(page);
  await page.getByRole("button", { name: "Find", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Column").selectOption("id");
  await dialog.getByLabel("Equals").fill("1.5");
  await dialog.getByRole("button", { name: "Apply filter" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter a valid integer");
  expect(await filters(page)).toEqual([["group", "==", "keep"]]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await filters(page)).toEqual([["group", "==", "keep"]]);
});

test("Find is opt-in and leaves editable fields and other page content alone", async ({
  page,
}) => {
  await mount(page, { enabled: false });
  const intercepted = await page.evaluate(() => {
    const key = (target) => {
      const event = new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const { panel } = window.findTest;
    const results = [key(panel.querySelector("perspective-viewer-datagrid"))];
    panel.find = true;
    const input = document.createElement("input");
    panel.append(input);
    results.push(key(input), key(document.body));
    return results;
  });
  expect(intercepted).toEqual([false, false, false]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Find refuses a configuration reporting OR filter semantics", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const viewer = window.findTest.panel.viewer;
    const original = viewer.getViewConfig.bind(viewer);
    Object.defineProperty(viewer, "getViewConfig", {
      value: async (...args) => ({
        ...(await original(...args)),
        filter_op: "or",
      }),
    });
  });
  await page.getByRole("button", { name: "Find", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Column").selectOption("name");
  await dialog.getByLabel("Equals").fill("Alpha");
  await dialog.getByRole("button", { name: "Apply filter" }).click();
  await expect(dialog.getByRole("alert")).toContainText("requires AND filters");
  expect(await filters(page)).toEqual([["group", "==", "keep"]]);
});

test("disabling Find or disconnecting closes its prompt and reconnection works", async ({
  page,
}) => {
  await mount(page);
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.evaluate(() => {
    window.findTest.panel.find = false;
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => {
    window.findTest.panel.find = true;
  });
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.evaluate(() => {
    const { panel } = window.findTest;
    panel.remove();
    document.body.append(panel);
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
});

test("keyboard Find changes only the focused panel in a split workspace", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const { panel } = window.findTest;
    panel.config = {
      ...panel.config,
      layout: {
        layout: {
          type: "split-layout",
          orientation: "horizontal",
          sizes: [1, 1],
          children: [
            { type: "tab-layout", tabs: ["left"] },
            { type: "tab-layout", tabs: ["right"] },
          ],
        },
        panels: {
          left: { table: "records", plugin: "Datagrid", columns: ["name"] },
          right: { table: "records", plugin: "Datagrid", columns: ["name"] },
        },
      },
    };
    await panel.save();
  });
  const right = page.locator("perspective-viewer-datagrid").nth(1);
  const slot = await right.getAttribute("slot");
  await right.locator("td").first().click();
  await page.keyboard.press("Control+f");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Column").selectOption("name");
  await dialog.getByLabel("Equals").fill("Beta");
  await dialog.getByRole("button", { name: "Apply filter" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await page.evaluate(() => window.findTest.panel.save());
  expect(saved.panels[slot].filter).toEqual([["name", "==", "Beta"]]);
  expect(
    Object.entries(saved.panels).find(([id]) => id !== slot)[1].filter,
  ).toEqual([]);
});

test("closing Find while schema loads does not reopen it or apply a filter", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const { panel } = window.findTest;
    const original = panel.viewer.getTable.bind(panel.viewer);
    Object.defineProperty(panel.viewer, "getTable", {
      value: async (...args) => {
        const table = await original(...args);
        const schema = table.schema.bind(table);
        table.schema = () =>
          new Promise((resolve) => {
            window.releaseFindSchema = async () => resolve(await schema());
          });
        return table;
      },
    });
    void panel.openFind();
  });
  await page.waitForFunction(() => !!window.releaseFindSchema);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  await page.evaluate(() => window.releaseFindSchema());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await filters(page)).toEqual([["group", "==", "keep"]]);
});
