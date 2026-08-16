import { expect, test } from "@playwright/test";

<<<<<<< before updating
test("registers a themed Perspective workspace without connecting eagerly", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  await page.evaluate(() => {
    const panel = document.createElement("perspective-panel");
    panel.theme = "dark";
    document.body.appendChild(panel);
=======
test.describe("Basics", () => {
  test("basic", async () => {
    await expect("").toBe("");
>>>>>>> after updating
  });

  await expect(page.locator("perspective-panel")).toHaveJSProperty(
    "theme",
    "Pro Dark",
  );
  await expect(
    page.locator("perspective-panel perspective-workspace"),
  ).toHaveAttribute("theme", "Pro Dark");
});
