import { expect, test } from "@playwright/test";

/* A downstream component library on the same page as `<perspective-panel>`.
 *
 * The library ships its own element built on Perspective but imports none of it, borrowing the
 * engine spaday-perspective publishes; and it has no Python of its own, binding through spaday's
 * package surface. These check that the whole arrangement works in a browser, not just that each
 * half does on its own. See spaday_perspective/tests/integration.py.
 */

const PAGE = "http://127.0.0.1:8016";

test("both libraries render on one page with no collision", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(PAGE);

  await expect(page.locator("#panel perspective-viewer")).toBeAttached({
    timeout: 60000,
  });
  await expect(page.locator("#grid perspective-viewer")).toBeAttached({
    timeout: 60000,
  });
  await expect(page.locator("perspective-viewer-datagrid")).toHaveCount(2, {
    timeout: 60000,
  });
  // a second copy of Perspective would have thrown from customElements.define
  expect(errors).toEqual([]);
  // and the downstream element records any failure of its own rather than rendering nothing
  expect(await page.locator("#grid").getAttribute("data-error")).toBeNull();
});

test("the downstream grid borrows the engine rather than loading its own", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sockets = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.goto(PAGE);
  await expect(page.locator("#grid perspective-viewer")).toBeAttached({
    timeout: 60000,
  });

  const r = await page.evaluate(async () => {
    const grid = document.querySelector("#grid");
    const lent = await globalThis.__spadayPerspective.worker();
    return {
      borrowed: (await grid.borrowedWorker()) === lent,
      version: grid.dataset.engineVersion,
      published: globalThis.__spadayPerspective.version,
    };
  });
  // the grid's engine is the page's engine, not a second one
  expect(r.borrowed).toBe(true);
  expect(r.version).toBe(r.published);
  expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
  // only the panel talks to the server; the grid's rows never leave the page
  expect(sockets.filter((url) => url.includes("/perspective"))).toHaveLength(1);
});

test("the downstream rows and the server-held table both render their data", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(PAGE);
  await expect(page.locator("perspective-viewer-datagrid")).toHaveCount(2, {
    timeout: 60000,
  });
  // NVDA is in the rows handed to the grid in the page and in the table held by the server
  await expect(page.locator("#grid")).toContainText("NVDA", { timeout: 60000 });
  await expect(page.locator("#panel")).toContainText("NVDA", {
    timeout: 60000,
  });
});

test("the downstream bundle satisfies the Python surface it is bound to", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // the check is generated from the schemas the downstream package carries, so this fails if the
  // bundle stops registering the tag or drops the rows property
  await page.goto(PAGE);
  const script = await (
    await page.request.get(`${PAGE}/conformance.js`)
  ).text();
  await expect(page.locator("#grid perspective-viewer")).toBeAttached({
    timeout: 60000,
  });
  expect(await page.evaluate(script)).toEqual([]);
});
