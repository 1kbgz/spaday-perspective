import { expect, test } from "@playwright/test";

test("registers a themed Perspective viewer without connecting eagerly", async ({
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
  // Perspective 5: the viewer IS the multi-panel workspace element, and theme is
  // viewer config (applied via restore), not an attribute
  await expect(
    page.locator("perspective-panel perspective-viewer"),
  ).toBeAttached();
});

test("an unthemed panel follows the wa-dark page mode until themed explicitly", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  await page.evaluate(() => {
    document.body.appendChild(document.createElement("perspective-panel"));
  });
  const panel = page.locator("perspective-panel");
  await expect(panel).toHaveJSProperty("theme", "Pro Light");

  await page.evaluate(() => document.documentElement.classList.add("wa-dark"));
  await expect(panel).toHaveJSProperty("theme", "Pro Dark");

  await page.evaluate(() =>
    document.documentElement.classList.remove("wa-dark"),
  );
  await expect(panel).toHaveJSProperty("theme", "Pro Light");

  // an explicit theme takes over: later mode flips no longer apply
  await page.evaluate(() => {
    document.querySelector("perspective-panel").theme = "dark";
    document.documentElement.classList.remove("wa-dark");
  });
  await expect(panel).toHaveJSProperty("theme", "Pro Dark");
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

test("re-dispatches viewer events and drives element options from props", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8015");
  await expect(page.locator("perspective-panel")).toBeVisible();
  const r = await page.evaluate(async () => {
    const panel = document.querySelector("perspective-panel");
    // the settings prop drives toggleConfig(force) through the queue; the saved workspace
    // token reflects it (`active` present iff the sidebar is open) and is workspace-shaped
    panel.settings = false;
    const closed = await panel.save(); // save() awaits the queue, then saveWorkspace()
    panel.settings = true;
    const opened = await panel.save();
    // perspective's own events don't bubble; they arrive only via the panel's re-dispatch
    const seen = [];
    document.addEventListener("perspective-toggle-settings", (event) =>
      seen.push(event.detail),
    );
    const fired = new Promise((resolve, reject) => {
      panel.addEventListener("perspective-toggle-settings", resolve, {
        once: true,
      });
      setTimeout(
        () => reject(new Error("no perspective-toggle-settings within 20s")),
        20000,
      );
    });
    panel.viewer.toggleConfig(); // the no-arg toggle emits the event (the force form does not in 5.2)
    await fired;
    return {
      seen: seen.length,
      panels: "panels" in closed,
      closedActive: "active" in closed,
      openedActive: "active" in opened,
    };
  });
  expect(r.seen).toBeGreaterThan(0);
  expect(r.panels).toBe(true);
  expect(r.closedActive).toBe(false);
  expect(r.openedActive).toBe(true);
});
