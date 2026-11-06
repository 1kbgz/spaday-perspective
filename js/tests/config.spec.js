import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const cases = JSON.parse(
  read("../../spaday_perspective/tests/fixtures/config-validation.json"),
);

test("browser configuration validation agrees with Python fixtures", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  const result = await page.evaluate(async ({ valid, invalid }) => {
    // the setter checks schemas once the bundle has Perspective's validator, which any
    // panel's `perspective-ready` follows
    const probe = document.createElement("perspective-panel");
    probe.config = { local: true };
    document.body.append(probe);
    await new Promise((resolve) =>
      probe.addEventListener("perspective-ready", resolve, { once: true }),
    );
    const panel = document.createElement("perspective-panel");
    const accepted = valid.map((config) => {
      panel.config = config;
      return panel.config;
    });
    const errors = invalid.map(([config]) => {
      const previous = panel.config;
      try {
        panel.config = config;
        return null;
      } catch (error) {
        return { message: error.message, unchanged: panel.config === previous };
      }
    });
    return { accepted, errors };
  }, cases);
  expect(result.accepted).toEqual(cases.valid);
  for (let i = 0; i < cases.invalid.length; i++) {
    expect(result.errors[i].message).toContain(cases.invalid[i][1]);
    expect(result.errors[i].unchanged).toBe(true);
  }
});

// The Python enums and the wrapper's `Alignment` cells are the only Datagrid values this package
// repeats; they are checked against the installed plugin's declarations.
test("repeated Datagrid enums match the installed plugin", () => {
  const types = read(
    "../node_modules/@perspective-dev/viewer-datagrid/dist/esm/types.d.ts",
  );
  const declared = (name) =>
    [
      ...types
        .match(new RegExp(`export type ${name} =([\\s\\S]*?);`))[1]
        .matchAll(/"([^"]+)"/g),
    ]
      .map((m) => m[1])
      .sort();
  const python = read("../../spaday_perspective/config.py");
  const members = (name) =>
    [
      ...python
        .match(
          new RegExp(`class ${name}\\(StrEnum\\):\\n([\\s\\S]*?)\\n\\n`),
        )[1]
        .matchAll(/= "([^"]+)"/g),
    ]
      .map((m) => m[1])
      .sort();
  expect(members("EditMode")).toEqual(declared("EditMode"));
  expect(members("Alignment")).toEqual(declared("Align"));
});

test("plugin settings are reported by the viewer when applied", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  const result = await page.evaluate(async () => {
    const worker = await globalThis.__spadayPerspective.worker();
    await worker.table([{ symbol: "NVDA", price: 181 }], { name: "quotes" });
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "display:block;width:800px;height:400px";
    document.body.append(panel);
    const errors = [];
    panel.addEventListener("perspective-error", (event) =>
      errors.push(String(event.detail)),
    );
    const apply = async (plugin_config, plugin = "Datagrid") => {
      errors.length = 0;
      panel.config = {
        local: true,
        layout: {
          layout: { type: "tab-layout", tabs: ["grid"] },
          panels: { grid: { table: "quotes", plugin, plugin_config } },
        },
      };
      await panel.save();
      return errors.slice();
    };
    return {
      rejected: await apply({ edit_mode: "invalid" }),
      accepted: await apply({ edit_mode: "SELECT_REGION", scroll_lock: true }),
      chart: await apply({ include_zero: true }, "Y Bar"),
      saved: await panel.save(),
    };
  });
  expect(result.rejected).toEqual([
    expect.stringContaining("Invalid `plugin_config.edit_mode`"),
  ]);
  expect(result.accepted).toEqual([]);
  expect(result.chart).toEqual([]);
  expect(result.saved.panels.grid.plugin).toBe("Y Bar");
});

test("bundled themes and custom theme names remain usable", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  const result = await page.evaluate(async () => {
    await globalThis.__spadayPerspective.worker();
    const panel = document.createElement("perspective-panel");
    document.body.append(panel);
    panel.theme = "Company Dark";
    return {
      themes: await panel.viewer.getThemes(),
      custom: panel.theme,
    };
  });
  expect(result.themes.sort()).toEqual(["Pro Dark", "Pro Light"]);
  expect(result.custom).toBe("Company Dark");
});
