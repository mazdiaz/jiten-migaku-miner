import { afterEach, describe, expect, it } from "vitest";
import { testServerEnvironment } from "./environment";

const originalMode = process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC;
const originalDatabaseUrl = process.env.TEST_DATABASE_URL;

afterEach(() => {
  if (originalMode === undefined) delete process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC;
  else process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC = originalMode;
  if (originalDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = originalDatabaseUrl;
});

describe("test server environment", () => {
  it("keeps ordinary E2E runs in server-first fallback when mode is unset", () => {
    delete process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC;
    process.env.TEST_DATABASE_URL = "configured-test-database";

    expect(testServerEnvironment("http://127.0.0.1:8920").NEXT_PUBLIC_LOCAL_FIRST_SYNC).toBe("0");
  });

  it("passes explicit local-first mode to the test server", () => {
    process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC = "1";
    process.env.TEST_DATABASE_URL = "configured-test-database";

    expect(testServerEnvironment("http://127.0.0.1:8920").NEXT_PUBLIC_LOCAL_FIRST_SYNC).toBe("1");
  });
});
