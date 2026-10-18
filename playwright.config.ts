import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 12_000 },
  use: {
    actionTimeout: 15_000,
    baseURL: "https://127.0.0.1:4173",
    ignoreHTTPSErrors: true,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx tests/browser/server.ts",
    url: "https://127.0.0.1:4173/health",
    ignoreHTTPSErrors: true,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
