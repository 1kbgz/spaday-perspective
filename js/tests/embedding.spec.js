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
  await page.waitForFunction(() => !!globalThis.__spadayPerspective);
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

test("narrow workspace frames stay bounded and resize by dragging", async ({
  page,
}) => {
  await mount(page);
  await page.locator("#embedded").evaluate(async (panel) => {
    panel.style.width = "480px";
    panel.config = {
      local: true,
      layout: {
        panels: {
          left: {
            table: "rows",
            title: "A very long title that must stay inside the narrow pane",
          },
          right: {
            table: "rows",
            title: "Another very long title that must not overflow",
          },
        },
        layout: {
          type: "split-layout",
          orientation: "horizontal",
          sizes: [0.5, 0.5],
          children: [
            { type: "tab-layout", tabs: ["left"] },
            { type: "tab-layout", tabs: ["right"] },
          ],
        },
      },
    };
    await panel.save();
  });
  const frames = page.locator("#embedded regular-layout-frame");
  await expect(frames).toHaveCount(2);
  const bounds = await page.locator("#embedded").evaluate((panel) => {
    const host = panel.getBoundingClientRect();
    return Array.from(
      panel.viewer.shadowRoot.querySelectorAll("regular-layout-frame"),
      (frame) => {
        const box = frame.getBoundingClientRect();
        return {
          width: box.width,
          // the layout is inset past the host by its divider band and clipped there
          inside: box.left >= host.left - 4 && box.right <= host.right + 3,
        };
      },
    );
  });
  for (const frame of bounds) {
    expect(frame.width).toBeLessThan(480 * 0.55);
    expect(frame.inside).toBe(true);
  }
  const layout = page.locator("#embedded regular-layout");
  const box = await layout.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(layout).toHaveCSS("cursor", "col-resize");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await frames.first().boundingBox()).width)
    .toBeGreaterThan(260);
});
