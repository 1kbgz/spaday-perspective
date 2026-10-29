import { expect, test } from "@playwright/test";

for (const architecture of ["local", "server", "client-server"]) {
  test(`filter restores during ${architecture} updates do not report deleted views`, async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("http://127.0.0.1:8016");
    await page.evaluate(async (architecture) => {
      const engine = globalThis.__spadayPerspective;
      const client =
        architecture === "local"
          ? await engine.worker()
          : await engine.client("/perspective");
      const name = `filters-${crypto.randomUUID()}`;
      const source = await client.table(
        [
          { id: 1, value: "one" },
          { id: 2, value: "two" },
        ],
        { name, index: "id" },
      );
      const panel = document.createElement("perspective-panel");
      panel.id = "filter-test";
      panel.style.cssText = "height:300px;width:600px";
      panel.rowActions = {
        [name]: {
          "@actions": {
            header: "Actions",
            position: "end",
            buttons: [{ action: "copy", label: "Copy", icon: "copy" }],
          },
        },
      };
      panel.config = {
        ...(architecture === "local"
          ? { local: true }
          : { ws_url: "/perspective" }),
        tables: [
          {
            name,
            index: "id",
            architecture: architecture === "local" ? "server" : architecture,
          },
        ],
        layout: {
          layout: { type: "tab-layout", tabs: ["rows"] },
          panels: { rows: { table: name, columns: ["id", "value"] } },
        },
      };
      window.filterErrors = [];
      panel.addEventListener("perspective-error", (event) =>
        window.filterErrors.push(String(event.detail)),
      );
      document.body.append(panel);
      await panel.save();
      window.filterTest = { panel, source };
    }, architecture);
    await expect(
      page.locator("#filter-test regular-table td").first(),
    ).toBeVisible();
    await page.evaluate(async () => {
      const { panel, source } = window.filterTest;
      for (let i = 0; i < 30; i++) {
        await Promise.all([
          source.update([{ id: 1, value: `update-${i}` }]),
          panel.viewer.restore(
            { filter: i % 2 ? [["id", "==", 1]] : [] },
            { panel: "rows" },
          ),
        ]);
      }
      await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          panel.viewer.restore(
            { filter: [["id", "==", (i % 2) + 1]] },
            { panel: "rows" },
          ),
        ),
      );
      await panel.viewer.restore(
        { filter: [["id", "==", 1]] },
        { panel: "rows" },
      );
      await source.update([{ id: 1, value: "final update" }]);
      await panel.viewer.flush();
    });
    await expect(
      page.locator("#filter-test perspective-viewer-datagrid"),
    ).toContainText("final update");
    await expect(
      page
        .locator("#filter-test")
        .getByRole("button", { name: "Copy", exact: true }),
    ).toHaveCount(1);
    expect(await page.evaluate(() => window.filterErrors)).toEqual([]);
    expect(errors).toEqual([]);
    await page.evaluate(async () => {
      const { panel, source } = window.filterTest;
      panel.config = {
        ...panel.config,
        tables: [],
        layout: { panels: {}, layout: { type: "tab-layout", tabs: [] } },
      };
      await panel.save();
      panel.remove();
      await source.delete({ lazy: true });
    });
  });
}
