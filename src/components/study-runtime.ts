import {
  configuredLocalFirstEnabled,
  configuredStorageModeLabel,
  localBootMessage,
  storageModeDiagnostic,
} from "../config/storage-mode";
import { canonicalWord } from "../domain/text";
import { createMinerController } from "../miner/controller";
import { createQueryController } from "../miner/query-controller";
import { type AppState, DEFAULT_VIEW } from "../miner/state";
import { createWorkerClient } from "../miner/worker-client";
import type { SessionQueueSnapshot, SessionQueueStore } from "../platform/session-queue";
import { isStorageUnavailableError } from "../storage/fallback";
import { createIndexedDbAppStore } from "../storage/indexed-db";
import {
  createLocalSyncStore,
  type LocalSyncMeta,
  type LocalSyncStore,
} from "../storage/local-sync";
import { createLocalWriteBarrier } from "../storage/local-write-barrier";
import { createRemoteAppStore, RemoteStoreError } from "../storage/remote-store";
import { createCloudSyncClient } from "../sync/cloud-client";
import {
  bootstrapLocalCache,
  createSyncEngine,
  type SyncEngine,
  type SyncStatus,
} from "../sync/engine";
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

const localFirstEnabled = configuredLocalFirstEnabled();

/** Owns the browser-only study surface. React owns its lifetime; Migaku owns parsed sentence descendants. */
export function mountStudy(onStatus: (status: CloudStatus) => void) {
  let disposed = false;
  let ready = false;
  let pending = 0;
  let failure: string | null = null;
  let pauseInteractions = () => {};
  const cleanup: Array<() => void> = [];

  const statusRemote = () => {
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

  let activeStatusUpdater = statusRemote;

  const fail = (error: unknown) => {
    failure = error instanceof Error ? error.message : String(error);
    activeStatusUpdater();
  };

  const publishStorageModeDiagnostic = () => {
    if (typeof window === "undefined") return;
    const target = window as typeof window & { __jitenStorageMode?: string };
    const mode = configuredStorageModeLabel();
    target.__jitenStorageMode = mode;
    if (process.env.NODE_ENV !== "test") console.info(storageModeDiagnostic(mode));
  };

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (pending > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", beforeUnload);
  cleanup.push(() => window.removeEventListener("beforeunload", beforeUnload));

  const bootRemote = async () => {
    activeStatusUpdater = statusRemote;
    const store = createRemoteAppStore({
      onPendingChange: (count) => {
        pending = count;
        activeStatusUpdater();
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
              body?.error ??
              `Storage request failed (${response.status}). Reload before continuing.`;
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
          activeStatusUpdater();
        }
      },
    });

    await store.initialize();
    let queue: SessionQueueSnapshot | null = await store.queue.load();
    if (disposed) return;
    const sessionQueueStore: SessionQueueStore = {
      load: () => (queue === null ? null : structuredClone(queue)),
      loadForDataset: async (datasetId) => {
        const saved = await store.queue.load(datasetId);
        return saved === null ? null : structuredClone(saved);
      },
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
      onImportTiming: (event) => {
        if (typeof window !== "undefined") {
          const target = window as unknown as {
            __importTimingEvents?: Array<{ stage: string; durationMs: number }>;
          };
          target.__importTimingEvents = target.__importTimingEvents ?? [];
          target.__importTimingEvents.push(event);
        }
      },
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
        activeStatusUpdater();
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
      onSwitchDataset: (datasetId) => controller.switchDataset?.(datasetId),
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
    activeStatusUpdater();
  };

  if (typeof window !== "undefined") {
    const target = window as unknown as {
      __bootTimingEvents?: Array<{ stage: string; durationMs: number }>;
    };
    target.__bootTimingEvents = [
      { stage: "local_boot", durationMs: 0 },
      { stage: "worker_dataset_load", durationMs: 0 },
      { stage: "first_query_ready", durationMs: 0 },
    ];
  }

  const recordBootTiming = (
    stage: "local_boot" | "worker_dataset_load" | "first_query_ready",
    durationMs: number,
  ) => {
    if (typeof window !== "undefined") {
      const target = window as unknown as {
        __bootTimingEvents?: Array<{ stage: string; durationMs: number }>;
      };
      target.__bootTimingEvents = target.__bootTimingEvents ?? [];
      const entry = target.__bootTimingEvents.find((e) => e.stage === stage);
      if (entry) {
        entry.durationMs = durationMs;
      } else {
        target.__bootTimingEvents.push({ stage, durationMs });
      }
    }
  };

  const bootLocalFirst = async () => {
    const bootStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    const writeBarrier = createLocalWriteBarrier();
    let localSyncStore: LocalSyncStore;
    let meta: LocalSyncMeta;
    try {
      localSyncStore = createLocalSyncStore(undefined, { writeBarrier });
      meta = await localSyncStore.getMeta();
      recordBootTiming(
        "local_boot",
        Math.round(
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - bootStart,
        ),
      );
    } catch (error) {
      if (isStorageUnavailableError(error)) {
        return bootRemote();
      }
      throw error;
    }

    const cloud = createCloudSyncClient("/api/sync");
    const remoteApplyStore = createIndexedDbAppStore({ recordSyncMutations: false });
    const initialLocalMessage = localBootMessage(meta.bootstrapComplete);
    onStatus({
      ready: false,
      error: failure !== null,
      message: failure ?? initialLocalMessage,
    });

    let bootstrapError: unknown = null;
    if (!meta.bootstrapComplete) {
      try {
        await bootstrapLocalCache({
          cloud,
          remoteApplyStore,
          localSyncStore,
          writeBarrier,
          isCancelled: () => disposed,
        });
        meta = await localSyncStore.getMeta();
      } catch (error) {
        if (!(error instanceof RemoteStoreError)) throw error;
        // Empty or stale local state remains usable while canonical cloud state is unavailable.
        bootstrapError = error;
      }
    }

    if (disposed) return;

    pending = (await localSyncStore.listOutbox(100)).length;
    let bootstrapPending = bootstrapError !== null;
    const bootstrapFailureStatus = (): SyncStatus => ({
      state: "error",
      pending,
      lastSyncAt: meta.lastSyncAt,
      message: bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError),
    });
    let currentSyncStatus: SyncStatus = bootstrapPending
      ? bootstrapFailureStatus()
      : { state: "idle", pending: 0, lastSyncAt: meta.lastSyncAt };

    const statusLocal = () => {
      if (disposed) return;
      if (!ready) {
        onStatus({
          ready: false,
          error: failure !== null,
          message: failure ?? initialLocalMessage,
        });
        return;
      }

      let message: string;
      switch (currentSyncStatus.state) {
        case "syncing":
          message = "Saved locally · Syncing…";
          break;
        case "offline":
          message = "Offline · changes saved locally";
          break;
        case "error":
          message = "Sync error · changes remain on this device";
          break;
        default:
          if (currentSyncStatus.pending > 0) {
            message = "Saved locally · Syncing…";
          } else if (currentSyncStatus.lastSyncAt !== null) {
            message = "Synced";
          } else {
            message = "Saved locally";
          }
          break;
      }

      onStatus({
        ready: true,
        error: failure !== null,
        message: failure ?? message,
      });
    };

    activeStatusUpdater = statusLocal;

    const workspace = await localSyncStore.loadWorkspace();
    let currentViewportStart = workspace?.viewportStart ?? 0;
    const initialDatasetId =
      workspace?.activeDatasetId ?? (await remoteApplyStore.datasets.getActive())?.id ?? null;
    let queue: SessionQueueSnapshot | null = initialDatasetId
      ? await localSyncStore.loadQueue(initialDatasetId)
      : null;

    let engine: SyncEngine;
    const localAppStore = createIndexedDbAppStore({ recordSyncMutations: true, writeBarrier });
    engine = createSyncEngine({
      cloud,
      localAppStore,
      remoteApplyStore,
      localSyncStore,
      writeBarrier,
    });
    cleanup.push(() => engine.dispose());

    cleanup.push(
      engine.subscribe((next) => {
        currentSyncStatus = next;
        pending = next.pending;
        activeStatusUpdater();
      }),
    );
    if (bootstrapPending) currentSyncStatus = bootstrapFailureStatus();
    const notifyOutbox = () => {
      void localSyncStore
        .listOutbox(100)
        .then((records) => {
          pending = records.length;
          activeStatusUpdater();
        })
        .catch(fail);
      if (engineStarted && !bootstrapPending) engine.notifyOutbox();
    };

    const sessionQueueStore: SessionQueueStore = {
      load: () => (queue === null ? null : structuredClone(queue)),
      loadForDataset: async (datasetId) => {
        const saved = await localSyncStore.loadQueue(datasetId);
        queue = saved === null ? null : structuredClone(saved);
        return saved === null ? null : structuredClone(saved);
      },
      save(snapshot) {
        queue = structuredClone(snapshot);
        const targetDatasetId = snapshot?.datasetId ?? latest?.dataset?.id ?? initialDatasetId;
        if (targetDatasetId) {
          void localSyncStore
            .saveQueue(snapshot, targetDatasetId, true)
            .then(notifyOutbox)
            .catch(fail);
        }
      },
      clear() {
        queue = null;
        const targetDatasetId = latest?.dataset?.id ?? initialDatasetId;
        if (targetDatasetId) {
          void localSyncStore.saveQueue(null, targetDatasetId, true).then(notifyOutbox).catch(fail);
        }
      },
    };

    const worker = createWorkerClient();
    cleanup.push(() => worker.dispose());
    const controller = createMinerController({
      store: localAppStore,
      worker,
      sessionQueueStore,
      legacyStorage: null,
      persistence: "indexeddb",
      initialViewportStart: currentViewportStart,
      prepareDataset: async (id) => {
        const start = typeof performance !== "undefined" ? performance.now() : Date.now();
        await engine.ensureDatasetCached(id);
        recordBootTiming(
          "worker_dataset_load",
          Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - start),
        );
      },
      onImportTiming: (event) => {
        if (typeof window !== "undefined") {
          const target = window as unknown as {
            __importTimingEvents?: Array<{ stage: string; durationMs: number }>;
          };
          target.__importTimingEvents = target.__importTimingEvents ?? [];
          target.__importTimingEvents.push(event);
        }
      },
    });

    controller.exportBackup = async () => {
      if (bootstrapPending) {
        throw new Error("Backup requires cloud sync; changes remain saved locally.");
      }
      try {
        await engine.flush();
        const pendingOutbox = await localSyncStore.listOutbox(1);
        if (pendingOutbox.length > 0) {
          throw new Error("Pending changes could not be synced.");
        }
      } catch {
        throw new Error("Backup requires cloud sync; changes remain saved locally.");
      }
      const cloudStore = createRemoteAppStore();
      return cloudStore.exportCompleteBackup();
    };

    const restoreLegacy = controller.restoreBackup.bind(controller);
    controller.restoreBackup = async (text) => {
      let complete = false;
      try {
        complete = (JSON.parse(text) as { version?: number } | null)?.version === 3;
      } catch {
        // The controller reports malformed and unsupported backups in durable UI state.
      }
      if (!complete) {
        try {
          await restoreLegacy(text);
          notifyOutbox();
        } catch (error) {
          const box = document.getElementById("errorBox");
          if (box) {
            box.hidden = false;
            box.textContent = `Backup could not be restored: ${error instanceof Error ? error.message : String(error)}`;
          }
          throw error;
        }
        return;
      }
      if (bootstrapPending) {
        throw new Error("Restore requires cloud sync before replacing saved data.");
      }
      try {
        ready = false;
        pauseInteractions();
        activeStatusUpdater();
        const cloudStore = createRemoteAppStore();
        await cloudStore.restoreCompleteBackup(text);
        await localSyncStore.clearLocalData();
        await bootstrapLocalCache({
          cloud,
          remoteApplyStore,
          localSyncStore,
          writeBarrier,
          isCancelled: () => disposed,
        });
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

    controller.clearSavedData = async () => {
      if (bootstrapPending) {
        const backupStatus = document.getElementById("backupStatus");
        if (backupStatus) backupStatus.textContent = "Clear requires cloud sync.";
        return;
      }
      const cloudStore = createRemoteAppStore();
      await cloudStore.clearAll();
      await localSyncStore.clearLocalData();
      window.location.reload();
    };

    let engineStarted = false;
    const startEngine = () => {
      if (engineStarted || disposed) return;
      engineStarted = true;
      engine.start();
      void engine.syncNow().catch(() => {});
    };

    let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let bootstrapRetryInFlight: Promise<void> | null = null;
    let bootstrapRetryListener: (() => void) | null = null;

    const scheduleBootstrapRetry = () => {
      if (!bootstrapPending || disposed || bootstrapRetryTimer !== null) return;
      bootstrapRetryTimer = setTimeout(() => {
        bootstrapRetryTimer = null;
        void retryBootstrap();
      }, 15_000);
    };

    const handleBootstrapRetryError = (error: unknown) => {
      if (disposed) return;
      if (!(error instanceof RemoteStoreError)) {
        fail(error);
        return;
      }
      bootstrapError = error;
      bootstrapPending = true;
      currentSyncStatus = bootstrapFailureStatus();
      activeStatusUpdater();
      scheduleBootstrapRetry();
    };

    const retryBootstrap = (): Promise<void> => {
      if (!bootstrapPending || disposed) return Promise.resolve();
      if (bootstrapRetryInFlight !== null) return bootstrapRetryInFlight;

      bootstrapRetryInFlight = (async () => {
        try {
          await bootstrapLocalCache({
            cloud,
            remoteApplyStore,
            localSyncStore,
            writeBarrier,
            isCancelled: () => disposed,
          });
          if (disposed) return;
          meta = await localSyncStore.getMeta();
          bootstrapPending = !meta.bootstrapComplete;
          if (bootstrapPending) {
            scheduleBootstrapRetry();
            return;
          }

          bootstrapError = null;
          if (bootstrapRetryTimer !== null) {
            clearTimeout(bootstrapRetryTimer);
            bootstrapRetryTimer = null;
          }
          if (bootstrapRetryListener !== null) {
            window.removeEventListener("online", bootstrapRetryListener);
            bootstrapRetryListener = null;
          }
          await controller.refreshFromStorage?.();
          const remainingOutbox = await localSyncStore.listOutbox(100);
          currentSyncStatus = {
            state: "idle",
            pending: remainingOutbox.length,
            lastSyncAt: meta.lastSyncAt,
          };
          activeStatusUpdater();
          startEngine();
        } catch (error) {
          handleBootstrapRetryError(error);
        } finally {
          bootstrapRetryInFlight = null;
        }
      })();
      return bootstrapRetryInFlight;
    };

    cleanup.push(() => {
      if (bootstrapRetryTimer !== null) clearTimeout(bootstrapRetryTimer);
      if (bootstrapRetryListener !== null)
        window.removeEventListener("online", bootstrapRetryListener);
    });

    const dom = getDomMap();
    const renderer = createRenderer(dom);
    const highlight = createHighlightAdapter(dom.resultsList);
    cleanup.push(() => highlight.destroy());
    let latest: Readonly<AppState> | null = null;
    let queryController!: ReturnType<typeof createQueryController>;

    let viewportDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    cleanup.push(() => {
      if (viewportDebounceTimer) clearTimeout(viewportDebounceTimer);
    });

    const scheduleSaveWorkspace = (start: number) => {
      currentViewportStart = start;
      if (viewportDebounceTimer) clearTimeout(viewportDebounceTimer);
      viewportDebounceTimer = setTimeout(() => {
        viewportDebounceTimer = null;
        if (disposed) return;
        void localSyncStore.saveWorkspace({
          id: "current",
          activeDatasetId: latest?.dataset?.id ?? initialDatasetId ?? null,
          viewportStart: currentViewportStart,
          queueMode: latest?.queue.mode ?? "normal",
          updatedAt: new Date().toISOString(),
        });
      }, 400);
    };

    const virtualList = createVirtualList(
      dom.resultsList,
      (entry, index) =>
        renderEntryNode(entry, index + 1, latest?.view ?? DEFAULT_VIEW, {
          queued:
            latest?.queue.normalizedWords.includes(canonicalWord(entry.normalizedWord)) ?? false,
          queueMode: latest?.queue.mode === "queue",
        }),
      {
        onRequestWindow: (start) => {
          queryController.setViewportStart(start);
          scheduleSaveWorkspace(start);
        },
      },
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
        const prevLatest = latest;
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

        if (
          prevLatest &&
          (prevLatest.dataset?.id !== state.dataset?.id ||
            prevLatest.queue.mode !== state.queue.mode)
        ) {
          void localSyncStore.saveWorkspace({
            id: "current",
            activeDatasetId: state.dataset?.id ?? null,
            viewportStart: currentViewportStart,
            queueMode: state.queue.mode,
            updatedAt: new Date().toISOString(),
          });
        }
        notifyOutbox();
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
      onSwitchDataset: (datasetId) => controller.switchDataset?.(datasetId),
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
    recordBootTiming(
      "first_query_ready",
      Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - bootStart),
    );
    if (new URL(window.location.href).searchParams.get("restored") === "1") {
      dom.backupStatus.textContent = "Complete backup restored.";
      window.history.replaceState(null, "", "/");
    }
    ready = true;
    activeStatusUpdater();

    cleanup.push(engine.onRemoteApplied(() => controller.refreshFromStorage?.()));
    if (bootstrapPending) {
      bootstrapRetryListener = () => {
        void retryBootstrap();
      };
      window.addEventListener("online", bootstrapRetryListener);
      scheduleBootstrapRetry();
      void retryBootstrap();
    } else {
      startEngine();
    }
  };

  const boot = async () => {
    publishStorageModeDiagnostic();
    if (localFirstEnabled) {
      try {
        await bootLocalFirst();
      } catch (error) {
        if (isStorageUnavailableError(error)) {
          await bootRemote();
        } else {
          throw error;
        }
      }
    } else {
      await bootRemote();
    }
  };

  void boot().catch(fail);
  return () => {
    disposed = true;
    for (const release of cleanup.reverse()) release();
  };
}
