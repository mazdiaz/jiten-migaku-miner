import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /production\.spec\.ts/,
  projects: [
    {
      name: "production",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "production-firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "production-webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:8931",
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: {
    command: "npm run build && npm run serve:root -- --port 8931",
    url: "http://127.0.0.1:8931/dist/",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
