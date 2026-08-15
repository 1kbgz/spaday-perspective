import { expect, test } from "@playwright/test";

test("registers a themed Perspective workspace without connecting eagerly", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  await page.evaluate(() => {
    const panel = document.createElement("perspective-panel");
    panel.theme = "dark";
    document.body.appendChild(panel);
  });

  await expect(page.locator("perspective-panel")).toHaveJSProperty(
    "theme",
    "Pro Dark",
  );
  await expect(
    page.locator("perspective-panel perspective-workspace"),
  ).toHaveAttribute("theme", "Pro Dark");
});

test("runs the Python workspace and submits trades", async ({ page }) => {
  await page.goto("http://127.0.0.1:8015");
  await expect(page.locator("perspective-panel")).toBeVisible();
  const count = page.locator(".metrics article").first().locator("strong");
  await expect(count).not.toHaveText("0");

  await page.getByLabel("Symbol").fill("NVDA");
  await page.getByLabel("Quantity").fill("75");
  await page.getByRole("button", { name: "Add trade" }).click();
  await expect(page.locator(".order-status")).toContainText(
    "Added 75 NVDA shares",
  );
});
