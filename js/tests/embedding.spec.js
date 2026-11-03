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

for (const theme of ["light", "dark"]) {
  test(`narrow workspace frames stay bounded with visible dividers (${theme})`, async ({
    page,
  }) => {
    await mount(page);
    await page.locator("#embedded").evaluate(async (panel, theme) => {
      panel.theme = theme;
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
    }, theme);
    const frames = page.locator("#embedded regular-layout-frame");
    await expect(frames).toHaveCount(2);
    // Compare the same pinned viewer with and without the wrapper stylesheet.
    const upstream = await page.locator("#embedded").evaluate((panel) => {
      const root = panel.viewer.shadowRoot;
      const sheets = [...root.adoptedStyleSheets];
      root.adoptedStyleSheets = sheets.filter(
        (sheet) =>
          !Array.from(sheet.cssRules).some((rule) =>
            rule.cssText.includes("--spa-perspective-divider-color"),
          ),
      );
      const border = getComputedStyle(
        root.querySelector("regular-layout-frame"),
      ).borderColor;
      root.adoptedStyleSheets = sheets;
      return border;
    });
    expect(upstream).toBe("rgba(0, 0, 0, 0)");
    const bounds = await page.locator("#embedded").evaluate((panel) => {
      const host = panel.getBoundingClientRect();
      return Array.from(
        panel.viewer.shadowRoot.querySelectorAll("regular-layout-frame"),
        (frame) => {
          const box = frame.getBoundingClientRect();
          const titlebar = frame.shadowRoot.querySelector('[part="titlebar"]');
          const style = getComputedStyle(frame);
          return {
            width: box.width,
            inside: box.left >= host.left && box.right <= host.right,
            border: style.borderColor,
            titleOverflow: getComputedStyle(titlebar).overflow,
          };
        },
      );
    });
    for (const frame of bounds) {
      expect(frame.width).toBeLessThanOrEqual(240);
      expect(frame.inside).toBe(true);
      expect(frame.border).not.toBe("rgba(0, 0, 0, 0)");
      expect(frame.titleOverflow).toBe("hidden");
    }
    await page.locator("#embedded").evaluate((panel) => {
      panel.style.setProperty(
        "--spa-perspective-divider-color",
        "rgb(102, 102, 102)",
      );
      panel.style.setProperty(
        "--spa-perspective-divider-hover-color",
        "rgb(0, 170, 255)",
      );
    });
    const layout = page.locator("#embedded regular-layout");
    await expect(layout).toHaveCSS("background-color", "rgb(102, 102, 102)");
    const box = await layout.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(layout).toHaveCSS("cursor", "col-resize");
    await expect(layout).toHaveCSS("background-color", "rgb(0, 170, 255)");
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, {
      steps: 4,
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await frames.first().boundingBox()).width)
      .toBeGreaterThan(260);
    await page.mouse.move(1, 1);
    await expect(layout).toHaveCSS("background-color", "rgb(102, 102, 102)");
  });
}
