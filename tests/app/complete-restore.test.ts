import { expect, it } from "vitest";
import { createMinerController } from "../../src/miner/controller";
import { createMemoryAppStore } from "../../src/storage/memory-store";

it("drops old decisions and preferences queued during complete replacement", async () => {
  const store = createMemoryAppStore();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cloudStore = Object.assign(store, {
    restoreCompleteBackup: async () => {
      entered();
      await gate;
      await store.clearAll();
    },
  });
  const controller = createMinerController({ store: cloudStore, legacyStorage: null });
  const restoring = controller.restoreBackup('{"version":3}');
  await started;
  controller.updateView({ density: "compact" });
  const deciding = controller.setWordDecision("old-ui-word", "known");
  release();
  await restoring;
  await deciding;
  expect(await store.wordDecisions.list()).toEqual([]);
  expect(await store.preferences.load()).toBeNull();
});
