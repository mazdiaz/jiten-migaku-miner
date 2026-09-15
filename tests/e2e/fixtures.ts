import { test as base } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { createRemoteAppStore } from "../../src/storage/remote-store";
import { TEST_OWNER, TEST_SECRET } from "../support/environment";

export type { Page } from "@playwright/test";
export { expect } from "@playwright/test";
export const test = base.extend<{ ownerSession: undefined }>({
  ownerSession: [
    async ({ context, baseURL }, use) => {
      if (!baseURL) throw new Error("Missing test origin");
      const salt = "authjs.session-token";
      const token = await encode({
        secret: TEST_SECRET,
        salt,
        token: { ownerId: TEST_OWNER, name: "Test owner" },
      });
      await context.addCookies([
        { name: salt, value: token, url: baseURL, httpOnly: true, sameSite: "Lax" },
      ]);
      const store = createRemoteAppStore({
        endpoint: `${baseURL}/api/store`,
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...init?.headers, origin: baseURL, cookie: `${salt}=${token}` },
          }),
      });
      await store.initialize();
      await store.clearAll();
      await use(undefined);
    },
    { auto: true },
  ],
});
