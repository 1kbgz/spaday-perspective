import { defineConfig, devices } from "@playwright/test";

const pyodideOnly = process.env.SPADAY_PERSPECTIVE_PYODIDE_ONLY === "1";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["line"],
    ["html", { outputFile: "playwright-report/index.html", open: "never" }],
    ["junit", { outputFile: "junit.xml" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm run start:tests",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    },
    ...(pyodideOnly
      ? []
      : [
          {
            command: "python -m spaday_perspective.example",
            url: "http://127.0.0.1:8015",
            reuseExistingServer: !process.env.CI,
            timeout: 120 * 1000,
          },
          {
            // a downstream component library sharing the page with <perspective-panel>
            // by path, not `-m`: the tests directory is not an importable package
            command: "python ../spaday_perspective/tests/integration.py",
            url: "http://127.0.0.1:8016",
            reuseExistingServer: !process.env.CI,
            timeout: 120 * 1000,
          },
        ]),
  ],
});
