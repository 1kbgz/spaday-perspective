import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const cases = JSON.parse(
  readFileSync(
    new URL(
      "../../spaday_perspective/tests/fixtures/config-validation.json",
      import.meta.url,
    ),
  ),
);
const contract = JSON.parse(
  readFileSync(
    new URL("../../spaday_perspective/config-contract.json", import.meta.url),
  ),
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

test("the validation contract matches the installed Datagrid schema and enums", async ({
  page,
}) => {
  const source = readFileSync(
    new URL(
      "../node_modules/@perspective-dev/viewer-datagrid/src/ts/types.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const values = (name) =>
    [
      ...source
        .match(new RegExp(`export type ${name} =([\\s\\S]*?);`))[1]
        .matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
  expect(values("EditMode").sort()).toEqual(
    [...contract.edit_mode.values].sort(),
  );
  expect(values("Align").sort()).toEqual([...contract.align.values].sort());
  await page.goto("/dist/index.html");
  const actual = await page.evaluate(async (aligns) => {
    await customElements.whenDefined("perspective-viewer-datagrid");
    const grid = document.createElement("perspective-viewer-datagrid");
    document.body.append(grid);
    const schema = grid.plugin_config_schema({}, { zebra_rows: 1 });
    const result = {};
    const visit = (field) => {
      if (field.kind === "Group") return field.fields.forEach(visit);
      if (field.kind === "Font") {
        result[field.key] = { kind: "string" };
        for (const [key, kind] of [
          ["size", "number"],
          ["bold", "boolean"],
          ["italic", "boolean"],
        ])
          if (field[key]) result[field[key].key] = { kind };
      } else if (field.kind === "Alignment")
        result[field.key] = { kind: "enum", values: aligns };
      else if (field.kind === "Enum")
        result[field.key] = {
          kind: "enum",
          values: field.variants.map((v) => v.value),
        };
      else {
        const kind = { Bool: "boolean", Number: "number", Color: "string" }[
          field.kind
        ];
        if (!kind)
          throw new Error(`Unhandled upstream config kind ${field.kind}`);
        result[field.key] = { kind };
      }
    };
    schema.fields.forEach(visit);
    grid.remove();
    return result;
  }, values("Align"));
  expect(actual).toEqual(contract);
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
