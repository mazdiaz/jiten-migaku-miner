export const TEST_SECRET = "local-e2e-only-secret-do-not-use-for-a-real-deployment-2026";
export const TEST_OWNER = "46370875";
export function testServerEnvironment(origin: string): Record<string, string> {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error(
      "Set TEST_DATABASE_URL to a disposable PostgreSQL database. Browser tests clear its application data.",
    );
  return {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    AUTH_SECRET: TEST_SECRET,
    OWNER_GITHUB_ID: TEST_OWNER,
    AUTH_GITHUB_ID: "local-test-client",
    AUTH_GITHUB_SECRET: "local-test-client-secret",
    AUTH_URL: origin,
    AUTH_TRUST_HOST: "true",
    NEXT_PUBLIC_LOCAL_FIRST_SYNC: process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC ?? "0",
  };
}
