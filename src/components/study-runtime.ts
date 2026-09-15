import { canonicalWord } from "../domain/text";
import { createMinerController } from "../miner/controller";
import { createQueryController } from "../miner/query-controller";
import { type AppState, DEFAULT_VIEW } from "../miner/state";
import { createWorkerClient } from "../miner/worker-client";
import type { SessionQueueSnapshot, SessionQueueStore } from "../platform/session-queue";
import { createRemoteAppStore } from "../storage/remote-store";
import { bindControls } from "../ui/controls";
import { getDomMap } from "../ui/dom";
import { createHighlightAdapter } from "../ui/highlight-adapter";
import { createPracticeMode } from "../ui/practice-mode";
import { createRenderer, renderEntryNode } from "../ui/renderer";
import { syncStickyToolbarClarity } from "../ui/sticky-toolbar-clarity";
import { createVirtualList } from "../ui/virtual-list";

export interface CloudStatus {
  message: string;
  error: boolean;
  ready: boolean;
}

/** Owns the browser-only study surface. React owns its lifetime; Migaku owns parsed sentence descendants. */
export function mountStudy(onStatus: (status: CloudStatus) => void) {
  let disposed = false;
  let ready = false;
  let pending = 0;
  let failure: string | null = null;
  let pauseInteractions = () => {};
  const cleanup: Array<() => void> = [];
  const status = () => {
    if (!disposed)
      onStatus({
        ready,
        error: failure !== null,
        message:
          failure ??
          (!ready
            ? "Loading saved vocabulary…"
            : pending > 0
              ? "Syncing with PostgreSQL…"
              : "Saved to PostgreSQL"),
      });
  };
  const fail = (error: unknown) => {
    failure = error instanceof Error ? error.message : String(error);
    status();
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (pending > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", beforeUnload);
  cleanup.push(() => window.removeEventListener("beforeunload", beforeUnload));
  const store = createRemoteAppStore({
    onPendingChange: (count) => {
      pending = count;
      status();
    },
    fetch: async (input, init) => {
      try {
        const response = await fetch(input, init);
        if (!response.ok) {
          const body = (await response
            .clone()
            .json()
            .catch(() => null)) as { error?: string } | null;
          failure =
            body?.error ?? `Storage request failed (${response.status}). Reload before continuing.`;
        }
        return response;
      } catch (error) {
        fail(
          new Error(
            "Connection lost. Changes may not have been saved. Reconnect and reload before continuing.",
          ),
        );
        throw error;
      } finally {
        status();
      }
    },
  });

  const boot = async () => {
    await store.initialize();
    let queue: SessionQueueSnapshot | null = await store.queue.load();
    if (disposed) return;
    const sessionQueueStore: SessionQueueStore = {
      load: () => (queue === null ? null : structuredClone(queue)),
      save(snapshot) {
        queue = structuredClone(snapshot);
        void store.queue.save(snapshot).catch(fail);
      },
      clear() {
        queue = null;
        void store.queue.save(null).catch(fail);
      },
    };
    const worker = createWorkerClient();
    cleanup.push(() => worker.dispose());
    const controller = createMinerController({
      store,
      worker,
      sessionQueueStore,
      legacyStorage: null,
      persistence: "postgresql",
    });
    const restoreLegacy = controller.restoreBackup.bind(controller);
    controller.restoreBackup = async (text) => {
      let complete = false;
      try {
        complete = (JSON.parse(text) as { version?: number } | null)?.version === 3;
      } catch {
        // The controller reports malformed and unsupported backups in durable UI state.
      }
      if (!complete) return restoreLegacy(text);
      try {
        ready = false;
        pauseInteractions();
        status();
        await restoreLegacy(text);
        // Keep the old controller inert even if navigation is interrupted.
        window.location.assign("/?restored=1");
      } catch (error) {
        const box = document.getElementById("errorBox");
        if (box) {
          box.hidden = false;
          box.textContent = `Backup could not be restored: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (!ready)
          fail(new Error("Restore could not be confirmed. Reload to check your saved data."));
        throw error;
      }
    };
    const dom = getDomMap();
    const renderer = createRenderer(dom);
    const highlight = createHighlightAdapter(dom.resultsList);
    cleanup.push(() => highlight.destroy());
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
    cleanup.push(() => virtualList.destroy());
    queryController = createQueryController({ controller, virtualList });
    cleanup.push(() => queryController.dispose());
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
    cleanup.push(() => practice.destroy());
    let lastQueueKey = "|normal";
    cleanup.push(
      controller.subscribe((state) => {
        if (disposed) return;
        latest = state;
        if (!practice.isActive()) {
          renderer.render(state);
          syncStickyToolbarClarity(dom, state);
        }
        practice.sync(state);
        const queueKey = `${state.queue.normalizedWords.join("\n")}|${state.queue.mode}`;
        if (!state.review.active && !practice.isActive()) {
          queryController.applyResult(state.result);
          if (queueKey !== lastQueueKey && state.result?.windowed) {
            virtualList.setTotal(state.result.totalEntries);
            virtualList.setWindow(Math.max(0, state.result.startIndex - 1), state.result.items);
          }
        }
        highlight.reconcile(dom.resultsList);
        lastQueueKey = queueKey;
      }),
    );
    const bindings = bindControls(dom, controller, {
      onSearch: (value) => queryController.search(value),
      onToggleImports: () => renderer.toggleImportsExpanded(),
      onToggleAdvanced: () => {
        renderer.toggleAdvancedPanel();
        if (latest) syncStickyToolbarClarity(dom, latest);
      },
      onToggleCoverage: () => renderer.toggleCoveragePanel(),
      confirmRestore: () =>
        window.confirm(
          "Restore this backup? A complete backup replaces datasets, queue, known words, decisions, preferences, and Anki state. A legacy backup replaces study settings only. Export a backup first if you want to keep current data.",
        ),
    });
    cleanup.push(() => bindings.dispose());
    pauseInteractions = () => {
      bindings.dispose();
      practice.destroy();
      queryController.dispose();
      document.querySelector(".app-shell")?.setAttribute("inert", "");
      dom.reviewOverlay.hidden = true;
    };
    await controller.init();
    if (new URL(window.location.href).searchParams.get("restored") === "1") {
      dom.backupStatus.textContent = "Complete backup restored.";
      window.history.replaceState(null, "", "/");
    }
    ready = true;
    status();
  };
  void boot().catch(fail);
  return () => {
    disposed = true;
    for (const release of cleanup.reverse()) release();
  };
}
