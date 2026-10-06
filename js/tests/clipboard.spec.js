import { chromium, expect, test } from "@playwright/test";

async function mount(page, url = "/dist/index.html") {
  await page.goto(url);
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
    panel.toolbar = true;
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
    panel.addEventListener("perspective-copy-error", (event) =>
      window.copyErrors.push(event.detail.message),
    );
    document.body.append(panel);
    await panel.save();
  });
  const cell = page
    .locator("perspective-viewer-datagrid regular-table tbody td")
    .first();
  await expect(cell).toBeVisible();
  await cell.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const panel = document.querySelector("#copy-panel");
        const grid = panel.querySelector("perspective-viewer-datagrid");
        return !!panel.viewer.getSelection({ panel: grid.slot });
      }),
    )
    .toBe(true);
}

async function expectedText(page) {
  return page.evaluate(async () => {
    const panel = document.querySelector("#copy-panel");
    const value = await panel.viewer.export({
      method: "plugin",
      panel: panel.querySelector("perspective-viewer-datagrid").slot,
    });
    return typeof value === "string" ? value : value.text();
  });
}

for (const activation of ["Control+c", "Meta+c", "button"]) {
  test(`copies real grid text with ${activation}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mount(page);
    const text = await expectedText(page);
    expect(text).toContain("AAPL");
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
    if (activation === "button")
      await page
        .getByRole("button", { name: "Copy selection", exact: true })
        .click();
    else await page.keyboard.press(activation);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(text);
    expect(await page.evaluate(() => window.copyErrors)).toEqual([]);
  });
}

test("reconnecting reinstalls exactly one clipboard handler", async ({
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
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    window.writeCalls = 0;
    navigator.clipboard.write = (...args) => {
      window.writeCalls++;
      return write(...args);
    };
  });
  await page
    .locator("perspective-viewer-datagrid regular-table tbody td")
    .nth(1)
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const panel = document.querySelector("#copy-panel");
        return !!panel.viewer.getSelection({
          panel: panel.querySelector("perspective-viewer-datagrid").slot,
        });
      }),
    )
    .toBe(true);
  const text = await expectedText(page);
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(text);
  expect(await page.evaluate(() => window.writeCalls)).toBe(1);
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

for (const cancel of [
  "selection",
  "outside focus",
  "another workspace",
  "disconnect",
]) {
  test(`cancels a delayed export after ${cancel}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mount(page);
    await page.evaluate(() => {
      const panel = document.querySelector("#copy-panel");
      const original = panel.viewer.export.bind(panel.viewer);
      Object.defineProperty(panel.viewer, "export", {
        configurable: true,
        value: async (...args) => {
          const value = await original(...args);
          await new Promise((resolve) => {
            window.finishExport = resolve;
          });
          return value;
        },
      });
      window.writes = [];
      navigator.clipboard.write = async (items) => {
        try {
          window.writes.push(
            await (await items[0].getType("text/plain")).text(),
          );
        } catch {
          window.cancelled = true;
        }
      };
    });
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => typeof window.finishExport))
      .toBe("function");
    if (cancel === "selection")
      await page
        .locator("perspective-viewer-datagrid regular-table tbody td")
        .nth(1)
        .click();
    else if (cancel === "outside focus")
      await page.evaluate(() => {
        const input = document.createElement("input");
        document.body.append(input);
        input.focus();
      });
    else if (cancel === "another workspace") {
      await page.evaluate(async () => {
        const other = document.createElement("perspective-panel");
        other.id = "other";
        other.style.cssText = "display:block;width:800px;height:400px";
        other.config = document.querySelector("#copy-panel").config;
        document.body.append(other);
        await other.save();
      });
      await page
        .locator("#other perspective-viewer-datagrid regular-table tbody td")
        .first()
        .click();
    } else
      await page.evaluate(() => document.querySelector("#copy-panel").remove());
    await page.evaluate(() => window.finishExport());
    await expect.poll(() => page.evaluate(() => window.cancelled)).toBe(true);
    expect(await page.evaluate(() => window.writes)).toEqual([]);
    expect(await page.evaluate(() => window.copyErrors)).toEqual([]);
  });
}

test("reports denied copying without an unhandled rejection", async ({
  page,
  context,
}) => {
  await context.grantPermissions([]);
  await mount(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => {
    document.execCommand = () => false;
  });
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => window.copyErrors.length))
    .toBe(1);
  expect(errors).toEqual([]);
});

test("copies selected cells on an actual insecure HTTP origin", async () => {
  const browser = await chromium.launch({
    args: [
      "--host-resolver-rules=MAP spaday.test 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  try {
    const page = await browser.newPage();
    await mount(page, "http://spaday.test:3000/dist/index.html");
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    expect(await page.evaluate(() => typeof navigator.clipboard)).toBe(
      "undefined",
    );
    const text = await expectedText(page);
    await page.evaluate(() => {
      document.addEventListener(
        "copy",
        (event) => {
          const set = event.clipboardData.setData.bind(event.clipboardData);
          event.clipboardData.setData = (type, value) => {
            window.fallbackText = value;
            set(type, value);
          };
        },
        true,
      );
    });
    await page
      .getByRole("button", { name: "Copy selection", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.fallbackText))
      .toBe(text);
    expect(await page.evaluate(() => window.copyErrors)).toEqual([]);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .locator("perspective-viewer-datagrid regular-table tbody td")
      .first()
      .click({ button: "right" });
    expect(await expectedText(page)).toBe(text);
    await page
      .locator(".context-menu-item")
      .getByText("Copy", { exact: true })
      .click();
    await page
      .locator("perspective-copy-menu .dropdown-menu-item")
      .first()
      .click();
    await expect
      .poll(() => page.evaluate(() => window.copyErrors.length))
      .toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("falls back to a scoped text copy when Clipboard API is unavailable", async ({
  page,
}) => {
  await mount(page);
  const text = await expectedText(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    document.addEventListener(
      "copy",
      (event) => {
        const set = event.clipboardData.setData.bind(event.clipboardData);
        event.clipboardData.setData = (type, value) => {
          window.fallbackText = value;
          set(type, value);
        };
      },
      true,
    );
  });
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.fallbackText)).toBe(text);
});
