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
