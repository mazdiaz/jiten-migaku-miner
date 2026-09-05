import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:8920",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 8920",
    url: "http://127.0.0.1:8920/",
    reuseExistingServer: true,
  },
});
