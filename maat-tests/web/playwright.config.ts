import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./cases",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  outputDir: "../../artifacts/playwright/test-results",
  reporter: [
    ["line"],
    [
      "html",
      { outputFolder: "../../artifacts/playwright/report", open: "never" },
    ],
  ],
  use: {
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: process.env.MAAT_VIDEO === "1" ? "retain-on-failure" : "off",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    {
      name: "chrome-beta",
      use: { browserName: "chromium", channel: "chrome-beta" },
    },
    { name: "edge", use: { browserName: "chromium", channel: "msedge" } },
    {
      name: "edge-beta",
      use: { browserName: "chromium", channel: "msedge-beta" },
    },
  ],
});
