import "./styles/tokens.css";
import "./styles/layout.css";
import "./styles/entries.css";

import { createMinerController } from "./app/controller";
import { createQueryController } from "./app/query-controller";
import type { AppState } from "./app/state";
import { DEFAULT_VIEW } from "./app/state";
import { createFolderSource } from "./platform/folder-source";
import { bindControls } from "./ui/controls";
import { getDomMap } from "./ui/dom";
import { createHighlightAdapter } from "./ui/highlight-adapter";
import { createRenderer, renderEntryNode } from "./ui/renderer";
import { createVirtualList } from "./ui/virtual-list";

async function discoverFolderSources(controller: ReturnType<typeof createMinerController>, latest: Readonly<AppState>): Promise<void> {
  const folder = createFolderSource();
  const asAuto = (source: { name: string; text(): Promise<string> }) => ({
    name: `${source.name} (auto)`,
    text: () => source.text(),
  });
  if (latest.dataset === null) {
    const csv = await folder.newest("WORDS TO MINE", ".csv");
    if (csv !== null) await controller.importJiten(asAuto(csv));
  }
  if (latest.knownWords.size === 0) {
    const txt = await folder.newest("MIGAKU KNOWN WORDS", ".txt");
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
    (entry, index) => renderEntryNode(entry, index + 1, latest?.view ?? DEFAULT_VIEW, {
      queued: latest?.queue.normalizedWords.includes(entry.normalizedWord) ?? false,
      queueMode: latest?.queue.mode === "queue",
    }),
    { onRequestWindow: (start) => queryController.setViewportStart(start) },
  );
  queryController = createQueryController({ controller, virtualList });

  let lastQueueKey = `${""}|normal`;
  controller.subscribe((state) => {
    latest = state;
    renderer.render(state);
    queryController.applyResult(state.result);
    highlight.reconcile(dom.resultsList);
    const queueKey = `${state.queue.normalizedWords.join("\n")}|${state.queue.mode}`;
    if (queueKey !== lastQueueKey && state.result?.windowed === true) {
      virtualList.setTotal(state.result.totalEntries);
      virtualList.setWindow(Math.max(0, state.result.startIndex - 1), state.result.items);
    }
    lastQueueKey = queueKey;
  });
  bindControls(dom, controller, { onSearch: (value) => queryController.search(value) });
  await controller.init();
  if (latest !== null) await discoverFolderSources(controller, latest);
}

void bootstrap().catch((error: unknown) => {
  console.error("Jiten Migaku Miner failed to start.", error);
});
