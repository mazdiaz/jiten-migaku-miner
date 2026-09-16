import { defineConfig, devices } from "@playwright/test";
import { testServerEnvironment } from "./tests/support/environment";
const origin = "http://127.0.0.1:8920";
export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: /production\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  use: { baseURL: origin, contextOptions: { reducedMotion: "reduce" }, trace: "retain-on-failure" },
  webServer: {
    command: process.env.CI ? "npm run start" : "npm run dev",
    url: `${origin}/login`,
    env: testServerEnvironment(origin),
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
