import { expect, it } from "vitest";
import { createRemoteAppStore } from "../../src/storage/remote-store";

it("keeps pending status while complete operations are queued", async () => {
  const counts: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = createRemoteAppStore({
    onPendingChange: (count) => counts.push(count),
    fetch: async () => {
      await gate;
      return Response.json({ revision: 0, value: null });
    },
  });
  const first = store.initialize();
  const second = store.clearAll();
  expect(counts).toEqual([1, 2]);
  release();
  await Promise.all([first, second]);
  expect(counts).toEqual([1, 2, 1, 0]);
});
