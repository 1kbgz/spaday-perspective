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

test("mirrors client-server tables into a local worker with the configured index", async ({
  page,
}) => {
  test.setTimeout(120_000); // local engine boot (worker + wasm self-extraction) is slow cold
  await page.goto("http://127.0.0.1:8015");
  await expect(page.locator("perspective-panel")).toBeVisible();
  const r = await page.evaluate(async () => {
    const layout = (name) => ({
      layout: { type: "tab-layout", tabs: [name] },
      panels: {
        [name]: {
          table: "trades",
          plugin: "Datagrid",
          columns: ["symbol", "price"],
        },
      },
    });
    const make = (config) => {
      const panel = document.createElement("perspective-panel");
      panel.style.cssText = "display:block;width:600px;height:300px";
      panel.config = config;
      document.body.appendChild(panel);
      return panel;
    };
    const mirrored = make({
      ws_url: "/perspective",
      tables: [
        { name: "trades", architecture: "client-server", index: "symbol" },
      ],
      layout: layout("mirrored"),
    });
    const direct = make({
      ws_url: "/perspective",
      tables: ["trades"],
      layout: layout("direct"),
    });
    const size = async (panel) => {
      // restore re-keys panels to generated ids and binds tables asynchronously; poll the
      // active panel with wait:false (wait:true hangs on the pre-restore empty panel)
      let last;
      for (let i = 0; i < 60; i++) {
        try {
          const table = await panel.viewer.getTable({ wait: false });
          return await table.size();
        } catch (error) {
          last = String(error);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      throw new Error(`table never bound: ${last}`);
    };
    return { mirrored: await size(mirrored), direct: await size(direct) };
  });
  // the local indexed copy won the name lookup: one row per symbol
  expect(r.mirrored).toBe(5);
  // the plain-server panel still sees every trade on the websocket table
  expect(r.direct).toBeGreaterThanOrEqual(80);
});

test("the inner viewer fills the panel", async ({ page }) => {
  await page.goto("http://127.0.0.1:8015");
  const panel = page.locator("perspective-panel");
  await expect(panel).toBeVisible();
  // perspective-viewer has no intrinsic height; without the panel sizing it, the
  // workspace builds but renders as a 0-height blank
  const sizes = await page.evaluate(() => {
    const panel = document.querySelector("perspective-panel");
    const viewer = panel.querySelector("perspective-viewer");
    return { panel: panel.clientHeight, viewer: viewer.offsetHeight };
  });
  expect(sizes.panel).toBeGreaterThan(0);
  expect(sizes.viewer).toBe(sizes.panel);
});

test("a pre-load theme does not error the config-update dispatch", async ({
  page,
}) => {
  // spaday applies the theme prop before config, so the panel used to call
  // viewer.restore({theme}) on the empty element — creating a deferred panel with
  // no `table`, whose perspective-config-update dispatch logs
  // "[config-update dispatch] Panel has no `table`"
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto("http://127.0.0.1:8015");
  await expect(page.locator("perspective-panel")).toBeVisible();
  // wait until the workspace is actually bound (past the load/restore window)
  await page.waitForFunction(async () => {
    try {
      const table = await document
        .querySelector("perspective-panel")
        .viewer.getTable({ wait: false });
      return (await table.size()) >= 0;
    } catch {
      return false;
    }
  });
  await page.waitForTimeout(1000);
  expect(errors.filter((e) => e.includes("Panel has no"))).toEqual([]);
});

test("a closed-sidebar layout restore leaves the settings attribute unset", async ({
  page,
}) => {
  // Perspective 5.2's forced no-op settings toggle (restoreWorkspace with no
  // `active`) flips the persisted flag + host `settings` attribute, making the
  // datagrid render per-column Edit buttons and eat the first settings click
  await page.goto("http://127.0.0.1:8015");
  const panel = page.locator("perspective-panel");
  await expect(panel).toBeVisible();
  await page.waitForFunction(async () => {
    try {
      const table = await document
        .querySelector("perspective-panel")
        .viewer.getTable({ wait: false });
      return (await table.size()) >= 0;
    } catch {
      return false;
    }
  });
  await expect(panel.locator("perspective-viewer")).not.toHaveAttribute(
    "settings",
  );
});

test("theme applies to every panel, not just the active one", async ({
  page,
}) => {
  // Perspective 5 records a concrete theme per panel at creation and a bare
  // restore({theme}) restyles only the ACTIVE panel — unthemed background panels
  // would render the registry default (light) forever. save() is no witness (it
  // falls back to the element-level selected theme), so assert the RENDERED
  // background of every panel's datagrid.
  await page.goto("/dist/index.html");
  await page.evaluate(() => {
    const layout = {
      layout: { type: "tab-layout", tabs: ["a", "b"] },
      panels: {
        a: { table: "trades", plugin: "Datagrid" },
        b: { table: "trades", plugin: "Datagrid" },
      },
    };
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "display:block;width:600px;height:300px";
    panel.theme = "dark";
    panel.config = {
      ws_url: "ws://127.0.0.1:8015/perspective",
      tables: ["trades"],
      layout,
    };
    document.body.appendChild(panel);
  });
  const grids = page.locator("perspective-viewer-datagrid");
  await expect(grids).toHaveCount(2, { timeout: 30000 });
  const backgrounds = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll("perspective-viewer-datagrid")].map(
        (g) => getComputedStyle(g).backgroundColor,
      ),
    );
  await expect(async () => {
    const dark = await backgrounds();
    expect(dark[0]).toBe(dark[1]);
    expect(dark[0]).not.toBe("rgb(255, 255, 255)");
  }).toPass({ timeout: 15000 });
  await page.evaluate(() => {
    document.querySelector("perspective-panel").theme = "light";
  });
  await expect(async () => {
    const light = await backgrounds();
    expect(light[0]).toBe(light[1]);
    expect(light[0]).toBe("rgb(255, 255, 255)");
  }).toPass({ timeout: 15000 });
});

test("stamps the theme onto every panel of a multi-panel workspace", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("http://127.0.0.1:8015");
  await expect(page.locator("perspective-panel")).toBeVisible();
  const r = await page.evaluate(async () => {
    const panels = Object.fromEntries(
      ["a", "b", "c"].map((name) => [
        name,
        { table: "trades", plugin: "Datagrid", columns: ["symbol", "price"] },
      ]),
    );
    const panel = document.createElement("perspective-panel");
    panel.style.cssText = "display:block;width:900px;height:300px";
    panel.config = {
      ws_url: "/perspective",
      tables: ["trades"],
      layout: { layout: { type: "tab-layout", tabs: ["a", "b", "c"] }, panels },
    };
    document.body.appendChild(panel);
    const themes = async () => {
      const token = await panel.save(); // drains the queue first
      return Object.values(token.panels ?? {}).map((p) => p.theme);
    };
    // wait for the initial workspace (3 panels) to settle
    for (let i = 0; i < 60 && (await themes()).length !== 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 500));
    panel.theme = "dark"; // concurrent per-panel restores, live tables still streaming
    // immediately queue a layout replacement behind the theme work
    panel.config = {
      ...panel.config,
      layout: { layout: { type: "tab-layout", tabs: ["a", "b"] }, panels },
    };
    let saved = await themes();
    for (let i = 0; i < 60 && saved.length !== 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      saved = await themes();
    }
    return saved;
  });
  expect(r.length).toBe(2); // the queued layout replacement landed after the theme work
  for (const theme of r) expect(theme).toBe("Pro Dark");
});
