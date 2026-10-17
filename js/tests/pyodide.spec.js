import fs from "fs";
import { expect, test } from "@playwright/test";

const built = fs.existsSync("dist/lite/index.html");

async function scrollState(page) {
  return page.evaluate(() => {
    const findTable = (root) => {
      for (const element of root.querySelectorAll("*")) {
        if (element.localName === "regular-table") return element;
        if (element.shadowRoot) {
          const found = findTable(element.shadowRoot);
          if (found) return found;
        }
      }
    };
    return { page: scrollY, table: findTable(document).scrollTop };
  });
}

test("runs the complete example in Pyodide with a local Perspective engine", async ({
  page,
}) => {
  test.skip(!built, "run `make pyodide-example` first");
  test.setTimeout(180_000);
  const sockets = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));

  await page.goto("/dist/lite/index.html");
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.ready === "true" ||
      document.querySelector("#pyodide-status")?.textContent ===
        "Unable to start",
    undefined,
    { timeout: 150_000 },
  );
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("perspective-panel")).toBeVisible();
  await expect(page.locator("perspective-viewer-datagrid")).toBeAttached();
  expect(sockets).toEqual([]);

  await page.getByRole("button", { name: "Find", exact: true }).click();
  const find = page.getByRole("dialog", { name: "Find in column" });
  await find.getByLabel("Column").selectOption("symbol");
  await find.getByLabel("Equals").fill("AAPL");
  await find.getByRole("button", { name: "Apply filter" }).click();
  await expect(find).toHaveCount(0);
  expect(
    await page.evaluate(async () =>
      document.querySelector("perspective-panel").viewer.getViewConfig(),
    ),
  ).toMatchObject({ filter: [["symbol", "==", "AAPL"]] });
  await page.evaluate(() =>
    document.querySelector("perspective-panel").viewer.restore({ filter: [] }),
  );

  const panelBox = await page.locator("perspective-panel").boundingBox();
  await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + 120);
  const revealDelta = Math.max(
    120,
    panelBox.y + panelBox.height - page.viewportSize().height + 1,
  );
  for (let step = 0; step < 3; step++) {
    await page.mouse.wheel(0, Math.ceil(revealDelta / 3));
    await page.waitForTimeout(30);
  }
  const pageFirst = await scrollState(page);
  expect(pageFirst.page).toBeGreaterThan(0);
  expect(pageFirst.table).toBe(0);

  await page.waitForTimeout(180);
  await page.mouse.wheel(0, 400);
  await expect
    .poll(async () => (await scrollState(page)).table)
    .toBeGreaterThan(0);

  await page.evaluate(() => {
    const findTable = (root) => {
      for (const element of root.querySelectorAll("*")) {
        if (element.localName === "regular-table") return element;
        if (element.shadowRoot) {
          const found = findTable(element.shadowRoot);
          if (found) return found;
        }
      }
    };
    scrollTo(0, document.documentElement.scrollHeight);
    findTable(document).scrollTop = 0;
  });
  await page.waitForTimeout(180);
  const pageBottom = (await scrollState(page)).page;
  await page.mouse.wheel(0, -200);
  await expect
    .poll(() => page.evaluate(() => scrollY))
    .toBeLessThan(pageBottom);
  expect((await scrollState(page)).table).toBe(0);

  const initialSize = await page.evaluate(async () => {
    const panel = document.querySelector("perspective-panel");
    return (await panel.viewer.getTable({ wait: false })).size();
  });
  expect(initialSize).toBeGreaterThanOrEqual(80);

  await page
    .getByRole("button", { name: "Copy trade to form", exact: true })
    .first()
    .click();
  await expect(page.locator(".order-status")).toContainText("Copied trade ");
  const copiedKey = Number(
    (await page.locator(".order-status").textContent()).match(
      /Copied trade (\d+)/,
    )[1],
  );
  const copiedTrade = await page.evaluate(async (key) => {
    const table = await document
      .querySelector("perspective-panel")
      .viewer.getTable({ wait: false });
    const view = await table.view({ filter: [["id", "==", key]] });
    try {
      return (await view.to_json())[0];
    } finally {
      await view.delete();
    }
  }, copiedKey);
  await expect(page.getByLabel("Symbol", { exact: true })).toHaveValue(
    copiedTrade.symbol,
  );
  await expect(
    page.getByRole("combobox", { name: "Side", exact: true }),
  ).toHaveValue(copiedTrade.side);
  await expect(page.getByLabel("Quantity", { exact: true })).toHaveValue(
    String(copiedTrade.quantity),
  );

  await page.getByLabel("Symbol").fill("NVDA");
  await page.getByLabel("Quantity").fill("75");
  await page.getByRole("button", { name: "Add trade" }).click();
  await expect(page.locator(".order-status")).toContainText(
    "Added 75 NVDA shares",
  );

  await page
    .getByRole("button", { name: "Delete trade", exact: true })
    .first()
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Delete trade?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  const cancelledKey = Number(
    await confirmation.locator("strong").textContent(),
  );
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  expect(
    await page.evaluate(async (key) => {
      const table = await document
        .querySelector("perspective-panel")
        .viewer.getTable({ wait: false });
      const view = await table.view({ filter: [["id", "==", key]] });
      try {
        return (await view.to_json()).length;
      } finally {
        await view.delete();
      }
    }, cancelledKey),
  ).toBe(1);
  await expect(page.locator(".order-status")).toContainText(
    "Added 75 NVDA shares",
  );
  await page
    .getByRole("button", { name: "Delete trade", exact: true })
    .first()
    .click();
  const confirmedKey = Number(
    await confirmation.locator("strong").textContent(),
  );
  await confirmation
    .getByRole("button", { name: "Delete trade", exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.locator(".order-status")).toContainText("Deleted trade ");
  const deletedKey = Number(
    (await page.locator(".order-status").textContent()).match(
      /Deleted trade (\d+)/,
    )[1],
  );
  expect(deletedKey).toBe(confirmedKey);
  await expect
    .poll(() =>
      page.evaluate(async (key) => {
        const table = await document
          .querySelector("perspective-panel")
          .viewer.getTable({ wait: false });
        const view = await table.view({ filter: [["id", "==", key]] });
        try {
          return await view.to_json();
        } finally {
          await view.delete();
        }
      }, deletedKey),
    )
    .toEqual([]);

  await page.getByRole("button", { name: "Group by symbol" }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const saved = await document.querySelector("perspective-panel").save();
        return saved.panels[Object.keys(saved.panels)[0]].group_by;
      }),
    )
    .toEqual(["symbol", "side"]);
});
