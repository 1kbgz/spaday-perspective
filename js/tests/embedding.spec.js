import { expect, test } from "@playwright/test";
import { build } from "esbuild";

const webawesome = await build({
  stdin: {
    contents: ["tab-group", "tab", "tab-panel"]
      .map(
        (name) =>
          `import "@awesome.me/webawesome/dist/components/${name}/${name}.js";`,
      )
      .join("\n"),
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  write: false,
});

async function mount(page, tabs = false) {
  if (tabs)
    await page.route("**/webawesome-test.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: webawesome.outputFiles[0].text,
      }),
    );
  await page.goto("/dist/index.html");
  await page.evaluate(async (tabs) => {
    await customElements.whenDefined("perspective-panel");
    const client = await globalThis.__spadayPerspective.worker();
    await client.table(
      [
        { id: 1, value: "One" },
        { id: 2, value: "Two" },
      ],
      { name: "rows", index: "id" },
    );
    const panel = document.createElement("perspective-panel");
    panel.id = "embedded";
    panel.style.cssText = "width:100%;height:300px;min-width:0";
    panel.config = {
      local: true,
      layout: {
        panels: { main: { table: "rows", columns: ["id", "value"] } },
        layout: { type: "tab-layout", tabs: ["main"] },
      },
    };
    if (tabs) {
      await import("/webawesome-test.js");
      const group = document.createElement("wa-tab-group");
      group.style.width = "700px";
      group.innerHTML =
        '<wa-tab panel="other">Other</wa-tab><wa-tab panel="rows">Rows</wa-tab><wa-tab-panel name="other">Other content</wa-tab-panel><wa-tab-panel name="rows"></wa-tab-panel>';
      group.querySelector('[name="rows"]').append(panel);
      document.body.append(group);
    } else document.body.append(panel);
  }, tabs);
}

test("hideTabs reclaims space without hiding the toolbar or losing panels", async ({
  page,
}) => {
  await mount(page);
  const panel = page.locator("#embedded");
  await expect(page.locator("regular-table td").first()).toBeVisible();
  const before = await page
    .locator("perspective-viewer-datagrid")
    .boundingBox();
  const initial = await panel.evaluate((p) => p.saveClean());
  await panel.evaluate((p) => {
    p.hideTabs = true;
  });
  await expect(page.locator("perspective-viewer-tab")).toBeHidden();
  await expect
    .poll(
      async () =>
        (await page.locator("perspective-viewer-datagrid").boundingBox())
          .height,
    )
    .toBeGreaterThan(before.height + 20);
  expect(await panel.evaluate((p) => p.saveClean())).toEqual(initial);
  await panel.evaluate((p) => {
    p.toolbar = true;
    p.find = true;
  });
  await expect(
    page.getByRole("button", { name: "Find", exact: true }),
  ).toBeVisible();
  await panel.evaluate((p) => {
    p.hideTabs = false;
  });
  await expect(page.locator("perspective-viewer-tab")).toBeVisible();
  await expect(page.locator("regular-table td").first()).toBeVisible();
});

test("a sized grid renders after tab activation and follows container resizes", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mount(page, true);
  const rows = page.getByRole("tab", { name: "Rows", exact: true });
  for (let i = 0; i < 3; i++) {
    await rows.click();
    await expect(page.locator("regular-table td").first()).toBeVisible();
    await expect(page.locator("perspective-viewer-datagrid")).toContainText(
      "One",
    );
    if (i < 2)
      await page.getByRole("tab", { name: "Other", exact: true }).click();
  }
  await page.locator("wa-tab-group").evaluate((g) => {
    g.style.width = "400px";
  });
  await expect
    .poll(async () =>
      Math.round((await page.locator("#embedded").boundingBox()).width),
    )
    .toBe(400);
  await expect(page.locator("regular-table td").first()).toBeVisible();
  expect(errors).toEqual([]);
});
