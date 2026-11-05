import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const read = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const cases = JSON.parse(
  read("../../spaday_perspective/tests/fixtures/config-validation.json"),
);

test("browser configuration validation agrees with Python fixtures", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  await page.evaluate(() => customElements.whenDefined("perspective-panel"));
  const result = await page.evaluate(({ valid, invalid }) => {
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
        .match(new RegExp(`class ${name}\\(StrEnum\\):\\n([\\s\\S]*?)\\n\\n`))[1]
        .matchAll(/= "([^"]+)"/g),
    ]
      .map((m) => m[1])
      .sort();
  const alignments = [
    ...read("../src/ts/config.ts")
      .match(/const ALIGNMENTS = \[([\s\S]*?)\]/)[1]
      .matchAll(/"([^"]+)"/g),
  ]
    .map((m) => m[1])
    .sort();
  expect(members("EditMode")).toEqual(declared("EditMode"));
  expect(members("Alignment")).toEqual(declared("Align"));
  expect(alignments).toEqual(declared("Align"));
});

test("plugin settings are validated against the plugin's own schema when applied", async ({
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
    // the first restore of an empty viewer: the plugin can only be asked once the panel exists
    const first = await apply({ edit_mode: "invalid" });
    const rejected = {};
    for (const [key, value] of [
      ["edit_mode", "invalid"],
      ["scroll_lock", "false"],
      ["scroll_mode", true],
      ["row_height", -1],
      ["font_size", "12"],
      ["align", "diagonal"],
      ["zebra_color", "#fff"],
    ])
      rejected[key] = await apply({ [key]: value });
    // the charts plugin describes its own settings; a Datagrid setting is unknown to it
    rejected.chart = await apply({ edit_mode: "EDIT" }, "Y Bar");
    const accepted = {
      datagrid: await apply({
        edit_mode: "SELECT_REGION",
        scroll_lock: true,
        font_size: 100,
        align: "center",
        zebra_rows: 2,
        zebra_color: "#f0f0f0",
      }),
      chart: await apply({ include_zero: true, bar_inner_pad: 0.2 }, "Y Bar"),
    };
    const saved = await panel.save();
    return { first, rejected, accepted, saved };
  });
  const path = "config.layout.panels.grid.plugin_config.";
  expect(result.first).toEqual([
    expect.stringContaining(`${path}edit_mode: expected one of`),
  ]);
  for (const [key, errors] of Object.entries(result.rejected))
    expect(errors, key).toEqual([
      expect.stringContaining(path + (key === "chart" ? "edit_mode" : key)),
    ]);
  expect(result.rejected.chart[0]).toContain("not a Y Bar setting");
  expect(result.rejected.scroll_mode[0]).toContain("not a Datagrid setting");
  expect(result.rejected.zebra_color[0]).toContain("not a Datagrid setting");
  expect(result.rejected.row_height[0]).toContain("expected number >= 8");
  expect(result.accepted).toEqual({ datagrid: [], chart: [] });
  expect(result.saved.panels.grid.plugin).toBe("Y Bar");
});

test("bundled themes and theme validation remain usable", async ({ page }) => {
  await page.goto("/dist/index.html");
  const result = await page.evaluate(async () => {
    await globalThis.__spadayPerspective.worker();
    const panel = document.createElement("perspective-panel");
    document.body.append(panel);
    const errors = [];
    for (const [key, value] of [
      ["theme", " "],
      ["themes", "dark"],
      ["themes", [""]],
    ]) {
      try {
        panel[key] = value;
      } catch (error) {
        errors.push(error.message);
      }
    }
    panel.theme = "Company Dark";
    return {
      themes: await panel.viewer.getThemes(),
      custom: panel.theme,
      errors,
    };
  });
  expect(result.themes.sort()).toEqual(["Pro Dark", "Pro Light"]);
  expect(result.custom).toBe("Company Dark");
  expect(result.errors).toHaveLength(3);
});
