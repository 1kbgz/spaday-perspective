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

  const panelBox = await page.locator("perspective-panel").boundingBox();
  await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + 120);
  for (const delta of [40, 40, 40]) {
    await page.mouse.wheel(0, delta);
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

  await page.getByLabel("Symbol").fill("NVDA");
  await page.getByLabel("Quantity").fill("75");
  await page.getByRole("button", { name: "Add trade" }).click();
  await expect(page.locator(".order-status")).toContainText(
    "Added 75 NVDA shares",
  );

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
