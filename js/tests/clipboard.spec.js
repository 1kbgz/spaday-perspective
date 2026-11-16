import { expect, test } from "@playwright/test";

// `copy` and `export` are the viewer's own; these check the panel hands them through unchanged and
// that its one addition, Ctrl+C / Cmd+C inside a grid, goes through the same `copy`.
async function mount(page) {
  await page.goto("/dist/index.html");
  await page.evaluate(async () => {
    const worker = await globalThis.__spadayPerspective.worker();
    await worker.table(
      [
        { symbol: "AAPL", price: 210 },
        { symbol: "NVDA", price: 181 },
      ],
      { name: "clipboard" },
    );
    const panel = document.createElement("perspective-panel");
    panel.id = "copy-panel";
    panel.style.cssText = "display:block;width:800px;height:400px";
    panel.config = {
      local: true,
      layout: {
        layout: { type: "tab-layout", tabs: ["grid"] },
        panels: {
          grid: {
            table: "clipboard",
            plugin: "Datagrid",
            plugin_config: { edit_mode: "SELECT_REGION" },
          },
        },
      },
    };
    window.copyErrors = [];
    window.copyResults = [];
    panel.addEventListener("perspective-copy-error", (event) =>
      window.copyErrors.push(event.detail.message),
    );
    document.body.append(panel);
    for (const [name, options] of [
      ["Copy view", undefined],
      ["Copy selection", { method: "csv-selected" }],
    ]) {
      const button = document.createElement("button");
      button.textContent = name;
      button.addEventListener("click", () =>
        window.copyResults.push(
          panel.copy(options).then(
            () => "ok",
            (error) => `rejected: ${error.message ?? error}`,
          ),
        ),
      );
      document.body.append(button);
    }
    await panel.save();
  });
  await expect(
    page.locator("perspective-viewer-datagrid regular-table tbody td").first(),
  ).toBeVisible();
}

async function select(page, text = "AAPL") {
  await page
    .locator("perspective-viewer-datagrid regular-table tbody td")
    .getByText(text, { exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => !!document.querySelector("#copy-panel").viewer.getSelection(),
      ),
    )
    .toBe(true);
}

const exported = (page, method) =>
  page.evaluate(
    async (method) =>
      document.querySelector("#copy-panel").viewer.export({ method }),
    method,
  );

const results = (page) => page.evaluate(() => Promise.all(window.copyResults));

test("the default method copies the whole view and csv-selected only the selection", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mount(page);
  await select(page);
  const view = await exported(page, "csv");
  const selection = await exported(page, "csv-selected");
  expect(view).toContain("NVDA");
  expect(selection).toContain("AAPL");
  expect(selection).not.toContain("NVDA");
  await page.getByRole("button", { name: "Copy view", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(view);
  await page
    .getByRole("button", { name: "Copy selection", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(selection);
  expect(await results(page)).toEqual(["ok", "ok"]);
  expect(await page.evaluate(() => window.copyErrors)).toEqual([]);
});

test("copy hands the clipboard one item during the click", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mount(page);
  await select(page);
  const selection = await exported(page, "csv-selected");
  await page.evaluate(() => {
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    window.writes = [];
    // the item is handed over before the export resolves, holding a promise for its text
    navigator.clipboard.write = (items) => {
      window.writes.push(navigator.userActivation.isActive);
      return write(items);
    };
  });
  await page
    .getByRole("button", { name: "Copy selection", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(selection);
  expect(await page.evaluate(() => window.writes)).toEqual([true]);
  expect(await results(page)).toEqual(["ok"]);
});

test("copy rejects on denial and with nothing selected", async ({
  page,
  context,
}) => {
  await context.grantPermissions([]);
  await mount(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("button", { name: "Copy selection", exact: true })
    .click();
  await expect
    .poll(() => results(page))
    .toEqual(["rejected: Nothing is selected"]);
  await select(page);
  await page.getByRole("button", { name: "Copy view", exact: true }).click();
  const [, denied] = await results(page);
  expect(denied).toMatch(/^rejected: /);
  expect(denied).not.toBe("rejected: Nothing is selected");
  expect(errors).toEqual([]);
});

for (const key of ["Control+c", "Meta+c"]) {
  test(`${key} in a grid copies its selection as csv-selected`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mount(page);
    await select(page);
    const selection = await exported(page, "csv-selected");
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
    await page.keyboard.press(key);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(selection);
    expect(await page.evaluate(() => window.copyErrors)).toEqual([]);
  });
}

test("Ctrl+C with nothing selected reports the viewer's rejection", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mount(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  // focus the grid by selecting, then clear the selection
  await select(page);
  await page.evaluate(() =>
    document.querySelector("#copy-panel").viewer.setSelection(null),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => !!document.querySelector("#copy-panel").viewer.getSelection(),
      ),
    )
    .toBe(false);
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => window.copyErrors))
    .toEqual(["Nothing is selected"]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "sentinel",
  );
  expect(errors).toEqual([]);
});

test("reconnecting reinstalls exactly one keyboard handler", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mount(page);
  await page.evaluate(async () => {
    const panel = document.querySelector("#copy-panel");
    panel.remove();
    document.body.append(panel);
    await panel.save();
    // the viewer's methods are not writable, so count at the clipboard instead
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    window.writes = 0;
    navigator.clipboard.write = (items) => {
      window.writes++;
      return write(items);
    };
  });
  await select(page, "NVDA");
  const selection = await exported(page, "csv-selected");
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(selection);
  expect(await page.evaluate(() => window.writes)).toBe(1);
});

test("preserves ordinary editable and browser text copying", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const panel = document.querySelector("#copy-panel");
    const input = document.createElement("input");
    panel.append(input);
    const event = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(event);
    const paragraph = document.createElement("p");
    paragraph.textContent = "ordinary selected text";
    panel.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    getSelection().addRange(range);
    const selected = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    panel.querySelector("perspective-viewer-datagrid").dispatchEvent(selected);
    return [event.defaultPrevented, selected.defaultPrevented];
  });
  expect(result).toEqual([false, false]);
});

test("an external button copies the selection of the panel it names", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mount(page);
  await select(page);
  const selection = await exported(page, "csv-selected");
  await page.evaluate(async () => {
    const other = document.createElement("perspective-panel");
    other.id = "other";
    other.style.cssText = "display:block;width:800px;height:400px";
    other.config = document.querySelector("#copy-panel").config;
    document.body.append(other);
    await other.save();
    await navigator.clipboard.writeText("sentinel");
  });
  // selecting in the other panel does not disturb the first panel's selection
  await page
    .locator("#other regular-table tbody td")
    .getByText("NVDA", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Copy selection", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(selection);
  expect(await results(page)).toEqual(["ok"]);
});

test("export is the viewer's export", async ({ page }) => {
  await mount(page);
  const [panelCsv, viewerCsv, json] = await page.evaluate(async () => {
    const panel = document.querySelector("#copy-panel");
    return [
      await panel.export(),
      await panel.viewer.export(),
      await panel.export({ method: "json", panel: "grid" }),
    ];
  });
  expect(panelCsv).toBe(viewerCsv);
  expect(panelCsv.split("\n")[0]).toContain('"symbol"');
  // `json` resolves to the columns themselves, not text
  expect(json).toEqual({ symbol: ["AAPL", "NVDA"], price: [210, 181] });
});
