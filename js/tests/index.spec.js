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

test("an unthemed panel follows the wa-dark page mode until themed explicitly", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  await page.evaluate(() => {
    document.body.appendChild(document.createElement("perspective-panel"));
  });
  const workspace = page.locator("perspective-panel perspective-workspace");
  await expect(workspace).toHaveAttribute("theme", "Pro Light");

  await page.evaluate(() => document.documentElement.classList.add("wa-dark"));
  await expect(workspace).toHaveAttribute("theme", "Pro Dark");

  await page.evaluate(() =>
    document.documentElement.classList.remove("wa-dark"),
  );
  await expect(workspace).toHaveAttribute("theme", "Pro Light");

  // an explicit theme takes over: later mode flips no longer apply
  await page.evaluate(() => {
    document.querySelector("perspective-panel").theme = "dark";
    document.documentElement.classList.remove("wa-dark");
  });
  await expect(workspace).toHaveAttribute("theme", "Pro Dark");
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
