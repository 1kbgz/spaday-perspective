import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// `@perspective-dev/viewer` ships a Custom Elements Manifest. The panel's own manifest declares the
// viewer events it re-dispatches as inherited from the viewer, so their names, detail types and
// descriptions are checked against the installed viewer rather than maintained by hand.
const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const panel = read("../../spaday_perspective/components.cem.json").modules[0]
  .declarations[0];
const viewer = read(
  "../node_modules/@perspective-dev/viewer/dist/custom-elements.json",
)
  .modules.flatMap((module) => module.declarations ?? [])
  .find((declaration) => declaration.tagName === "perspective-viewer");
const sources = readdirSync(new URL("../src/ts/", import.meta.url))
  .filter((file) => file.endsWith(".ts"))
  .map((file) =>
    readFileSync(new URL(`../src/ts/${file}`, import.meta.url), "utf8"),
  );

test("re-dispatched viewer events are declared as the viewer declares them", () => {
  const redispatch = [
    ...sources
      .join("\n")
      .match(/const REDISPATCH = \[([\s\S]*?)\];/)[1]
      .matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]);
  expect(redispatch.length).toBeGreaterThan(0);
  const upstream = Object.fromEntries(
    viewer.events.map((event) => [event.name, event]),
  );
  const declared = Object.fromEntries(
    panel.events.map((event) => [event.name, event]),
  );
  for (const name of redispatch) {
    expect(upstream[name], `${name} is a viewer event`).toBeDefined();
    expect(declared[name], `${name} is declared by perspective-panel`).toEqual(
      expect.objectContaining({
        type: expect.objectContaining({ text: upstream[name].type.text }),
        description: upstream[name].description,
        inheritedFrom: {
          name: viewer.name,
          package: "@perspective-dev/viewer",
        },
      }),
    );
  }
  // only re-dispatched events claim to be inherited
  expect(
    panel.events
      .filter((event) => event.inheritedFrom)
      .map((event) => event.name)
      .sort(),
  ).toEqual([...redispatch].sort());
});

test("declared methods exist on the element", async ({ page }) => {
  await page.goto("/dist/index.html");
  await page.evaluate(() => customElements.whenDefined("perspective-panel"));
  const methods = panel.members
    .filter((member) => member.kind === "method")
    .map((member) => member.name);
  expect(methods.length).toBeGreaterThan(0);
  const missing = await page.evaluate((names) => {
    const element = document.createElement("perspective-panel");
    return names.filter((name) => typeof element[name] !== "function");
  }, methods);
  expect(missing).toEqual([]);
});
