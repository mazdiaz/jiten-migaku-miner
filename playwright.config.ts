import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: /production\.spec\.ts/,
  expect: { timeout: 10_000 },
  ...(process.env.CI ? {} : { workers: 4 }),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:8920",
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 8920",
    url: "http://127.0.0.1:8920/",
    reuseExistingServer: !process.env.CI,
  },
});
