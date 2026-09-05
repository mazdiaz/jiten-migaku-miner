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
    (entry, index) => renderEntryNode(entry, index + 1, latest?.view ?? DEFAULT_VIEW),
    { onRequestWindow: (start) => queryController.setViewportStart(start) },
  );
  queryController = createQueryController({ controller, virtualList });

  controller.subscribe((state) => {
    latest = state;
    renderer.render(state);
    queryController.applyResult(state.result);
    highlight.reconcile(dom.resultsList);
  });
  bindControls(dom, controller, { onSearch: (value) => queryController.search(value) });
  await controller.init();
  if (latest !== null) await discoverFolderSources(controller, latest);
}

void bootstrap().catch((error: unknown) => {
  console.error("Jiten Migaku Miner failed to start.", error);
});
