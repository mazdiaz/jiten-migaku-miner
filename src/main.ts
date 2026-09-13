import "./styles/tokens.css";
import "./styles/layout.css";
import "./styles/entries.css";
import "./styles/highlight.css";
import "./styles/toolbar-cleanup.css";
import "./styles/practice.css";

import { createMinerController } from "./app/controller";
import { createQueryController } from "./app/query-controller";
import type { AppState } from "./app/state";
import { DEFAULT_VIEW } from "./app/state";
import { canonicalWord } from "./domain/text";
import { createFolderSource } from "./platform/folder-source";
import { bindControls } from "./ui/controls";
import { getDomMap } from "./ui/dom";
import { createHighlightAdapter } from "./ui/highlight-adapter";
import { createPracticeMode } from "./ui/practice-mode";
import { createRenderer, renderEntryNode } from "./ui/renderer";
import { syncStickyToolbarClarity } from "./ui/sticky-toolbar-clarity";
import { createVirtualList } from "./ui/virtual-list";

async function discoverFolderSources(
  controller: ReturnType<typeof createMinerController>,
  latest: Readonly<AppState>,
): Promise<void> {
  const folder = createFolderSource();
  const asAuto = (source: { name: string; text(): Promise<string> }) => ({
    name: `${source.name} (auto)`,
    text: () => source.text(),
  });
  if (latest.dataset === null) {
    const csv = await folder.newest("/WORDS TO MINE", ".csv");
    if (csv !== null) await controller.importJiten(asAuto(csv));
  }
  if (latest.knownWords.size === 0) {
    const txt = await folder.newest("/MIGAKU KNOWN WORDS", ".txt");
    if (txt !== null) await controller.importKnown(asAuto(txt));
  }
}

async function bootstrap(): Promise<void> {
  const dom = getDomMap();
  const controller = createMinerController();
  const renderer = createRenderer(dom);
  const highlight = createHighlightAdapter(dom.resultsList);
  let latest: Readonly<AppState> | null = null;
  let queryController!: ReturnType<typeof createQueryController>;

  const virtualList = createVirtualList(
    dom.resultsList,
    (entry, index) =>
      renderEntryNode(entry, index + 1, latest?.view ?? DEFAULT_VIEW, {
        queued:
          latest?.queue.normalizedWords.includes(canonicalWord(entry.normalizedWord)) ?? false,
        queueMode: latest?.queue.mode === "queue",
      }),
    { onRequestWindow: (start) => queryController.setViewportStart(start) },
  );
  queryController = createQueryController({ controller, virtualList });

  const practice = createPracticeMode({
    controller,
    resultsList: dom.resultsList,
    onContentChanged: () => highlight.reconcile(dom.resultsList),
    onExit: (state) => {
      renderer.render(state);
      syncStickyToolbarClarity(dom, state);
      queryController.applyResult(state.result);
      highlight.reconcile(dom.resultsList);
    },
  });

  let lastQueueKey = `${""}|normal`;
  controller.subscribe((state) => {
    latest = state;
    // Practice, like Review, temporarily owns the shared Migaku-facing results
    // surface. Leave its one-card DOM alone while controller queries navigate
    // through the shuffled session.
    if (!practice.isActive()) {
      renderer.render(state);
      syncStickyToolbarClarity(dom, state);
    }
    practice.sync(state);
    const queueKey = `${state.queue.normalizedWords.join("\n")}|${state.queue.mode}`;
    const focusedModeOwnsResults = state.review.active || practice.isActive();
    if (!focusedModeOwnsResults) {
      queryController.applyResult(state.result);
      if (queueKey !== lastQueueKey && state.result?.windowed === true) {
        virtualList.setTotal(state.result.totalEntries);
        virtualList.setWindow(Math.max(0, state.result.startIndex - 1), state.result.items);
      }
    }
    highlight.reconcile(dom.resultsList);
    lastQueueKey = queueKey;
  });
  bindControls(dom, controller, {
    onSearch: (value) => queryController.search(value),
    onToggleImports: () => renderer.toggleImportsExpanded(),
    onToggleAdvanced: () => {
      renderer.toggleAdvancedPanel();
      if (latest !== null) syncStickyToolbarClarity(dom, latest);
    },
    onToggleCoverage: () => renderer.toggleCoveragePanel(),
  });
  await controller.init();
  if (latest !== null) await discoverFolderSources(controller, latest);
}

void bootstrap().catch((error: unknown) => {
  console.error("Jiten Migaku Miner failed to start.", error);
});
