import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 12_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx tests/browser/server.ts",
    url: "http://127.0.0.1:4173/health",
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
