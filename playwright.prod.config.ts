import { defineConfig, devices } from "@playwright/test";
import { testServerEnvironment } from "./tests/support/environment";

const origin = "http://127.0.0.1:8931";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /production\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  projects: [{ name: "production", use: { ...devices["Desktop Chrome"] } }],
  use: { baseURL: origin, contextOptions: { reducedMotion: "reduce" }, trace: "retain-on-failure" },
  webServer: {
    command: "npx next start --hostname 127.0.0.1 --port 8931",
    url: `${origin}/login`,
    env: testServerEnvironment(origin),
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
