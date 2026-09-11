import fs from "fs";
import { expect, test } from "@playwright/test";

const built = fs.existsSync("dist/lite/index.html");

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
