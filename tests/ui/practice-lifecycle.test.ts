// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createMinerController } from "../../src/miner/controller";
import { createMemoryAppStore } from "../../src/storage/memory-store";
import { createPracticeMode } from "../../src/ui/practice-mode";
import { renderMinerShell } from "../support/shell";

it("removes generated practice controls before a React remount", () => {
  document.body.innerHTML = renderMinerShell();
  const controller = createMinerController({ store: createMemoryAppStore(), legacyStorage: null });
  const resultsList = document.getElementById("resultsList")!;
  const first = createPracticeMode({ controller, resultsList });
  expect(document.querySelectorAll("#practiceButton")).toHaveLength(1);
  first.destroy();
  expect(document.querySelectorAll("#practiceButton")).toHaveLength(0);
  expect(document.querySelectorAll("#practiceOverlay")).toHaveLength(0);
  const second = createPracticeMode({ controller, resultsList });
  expect(document.querySelectorAll("#practiceButton")).toHaveLength(1);
  second.destroy();
});
