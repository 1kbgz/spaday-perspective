import { expect, test } from "@playwright/test";

test("Python Find applies typed filters, preserves other filters, and cancels without changes", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8015");
  await expect(page.locator("regular-table")).toBeVisible();
  const filters = () =>
    page
      .locator("#market-grid")
      .evaluate(
        async (panel) =>
          Object.values((await panel.saveWorkspace()).panels)[0].filter,
      );
  await page.getByRole("button", { name: "Buy trades", exact: true }).click();
  await expect.poll(filters).toEqual([["side", "==", "Buy"]]);
  const dialog = page.getByRole("dialog", { name: "Find trade", exact: true });
  for (const [column, value, term] of [
    ["symbol", "AAPL", "AAPL"],
    ["price", "175.25", 175.25],
  ]) {
    await page.getByRole("button", { name: "Find", exact: true }).click();
    await dialog
      .getByRole("combobox", { name: "Column", exact: true })
      .selectOption(column);
    await dialog.getByLabel("Equals", { exact: true }).fill(value);
    await dialog.getByRole("button", { name: "Apply filter" }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(filters).toEqual(
      expect.arrayContaining([
        [column, "==", term],
        ["side", "==", "Buy"],
      ]),
    );
  }
  const before = await filters();
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Column", exact: true })
    .selectOption("quantity");
  await dialog.getByLabel("Equals", { exact: true }).fill("1.5");
  await dialog.getByRole("button", { name: "Apply filter" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await filters()).toEqual(before);
  const removed = await page
    .locator("#market-grid")
    .evaluate((panel) => ["find", "openFind"].filter((name) => name in panel));
  expect(removed).toEqual([]);
});
