import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../domain/anki";
import type { WordDecision } from "../domain/types";
import type { AppStore } from "../storage/contracts";
import type { LocalSyncStore, SyncOutboxRecord } from "../storage/local-sync";
import type { LocalWriteBarrier } from "../storage/local-write-barrier";
import { RemoteStoreError } from "../storage/remote-store";
import type {
  CloudSyncPort,
  MaterializedSyncMutation,
  PreferencesValue,
  SessionQueueSnapshot,
} from "./contracts";

export type SyncStatus =
  | { state: "idle"; pending: number; lastSyncAt: string | null }
  | { state: "syncing"; pending: number; lastSyncAt: string | null }
  | { state: "offline"; pending: number; lastSyncAt: string | null; message: string }
  | { state: "error"; pending: number; lastSyncAt: string | null; message: string };

export interface SyncEngine {
  start(): void;
  syncNow(): Promise<void>;
  flush(): Promise<void>;
  ensureDatasetCached(datasetId: string): Promise<void>;
  subscribe(listener: (status: SyncStatus) => void): () => void;
  onRemoteApplied(listener: () => Promise<void> | void): () => void;
  notifyOutbox(): void;
  dispose(): void;
}

export interface SyncEngineOptions {
  cloud: CloudSyncPort;
  localAppStore: AppStore;
  remoteApplyStore: AppStore;
  localSyncStore: LocalSyncStore;
  now?: (() => string) | undefined;
  intervalMs?: number | undefined;
  debounceMs?: number | undefined;
  writeBarrier?: LocalWriteBarrier | undefined;
}

export async function ensureDatasetCached(
  datasetId: string,
  cloud: CloudSyncPort,
  remoteApplyStore: AppStore,
): Promise<void> {
  const state = await remoteApplyStore.datasets.cacheState?.(datasetId);
  if (state === "ready") return;

  const metadata = (await remoteApplyStore.datasets.list()).find(
    (candidate) => candidate.id === datasetId,
  );
  if (!metadata) throw new Error(`Dataset metadata missing: ${datasetId}`);

  await remoteApplyStore.datasets.stage(metadata, cloud.readDataset(datasetId, 2_000));
}

export interface BootstrapLocalCacheOptions {
  cloud: CloudSyncPort;
  remoteApplyStore: AppStore;
  localSyncStore: LocalSyncStore;
  localAppStore?: AppStore | undefined;
  now?: (() => string) | undefined;
  writeBarrier?: LocalWriteBarrier | undefined;
}

export async function bootstrapLocalCache(
  optionsOrCloud: BootstrapLocalCacheOptions | CloudSyncPort,
  remoteApplyStoreParam?: AppStore,
  localSyncStoreParam?: LocalSyncStore,
  nowParam?: () => string,
): Promise<void> {
  const options: BootstrapLocalCacheOptions =
    "cloud" in optionsOrCloud
      ? optionsOrCloud
      : {
          cloud: optionsOrCloud,
          remoteApplyStore: remoteApplyStoreParam!,
          localSyncStore: localSyncStoreParam!,
          ...(nowParam ? { now: nowParam } : {}),
        };

  const { cloud, remoteApplyStore, localSyncStore } = options;
  const readerStore = options.localAppStore ?? remoteApplyStore;
  const now = options.now ?? (() => new Date().toISOString());

  // Fetch canonical cloud state before taking the local reconciliation lock.
  // Local-first writes should remain available while the network is slow.
  const manifest = await cloud.bootstrap();
  const known = await cloud.readKnownWords();
  const decisions = await cloud.readDecisions();
  const preferences = await cloud.readPreferences();
  const queues = await cloud.readQueues();
  const anki = await cloud.readAnki();

  const performReconcile = async (): Promise<void> => {
    // Snapshot every pending mutation only after the reconciliation barrier is acquired.
    // Using the complete ordered outbox is required because a bulk restore can legitimately
    // produce more than the normal 100/1000-row sync batches.
    const currentMeta = await localSyncStore.getMeta();
    const pendingOutbox = await localSyncStore.listOutbox(Number.MAX_SAFE_INTEGER);

    const preserveDatasetIds = new Set<string>();
    let pendingActiveDatasetId: string | null = null;
    const pendingRemovedDatasets = new Set<string>();

    for (const record of pendingOutbox) {
      if (record.kind === "dataset.upload" && record.resourceId) {
        preserveDatasetIds.add(record.resourceId);
      } else if (record.kind === "dataset.activate" && record.resourceId) {
        pendingActiveDatasetId = record.resourceId;
        // A locally activated dataset is already cached and immutable. Preserve its
        // payload so replay does not downgrade it to metadata-only.
        preserveDatasetIds.add(record.resourceId);
      } else if (record.kind === "dataset.remove" && record.resourceId) {
        pendingRemovedDatasets.add(record.resourceId);
        if (pendingActiveDatasetId === record.resourceId) {
          pendingActiveDatasetId = null;
        }
      }
    }

    // Preserve the canonical active dataset when it is already cached. Datasets are
    // immutable after commit, so keeping the ready payload avoids a needless cloud
    // download while the short reconciliation barrier is held.
    if (
      manifest.activeDatasetId &&
      (await readerStore.datasets.cacheState?.(manifest.activeDatasetId)) === "ready"
    ) {
      preserveDatasetIds.add(manifest.activeDatasetId);
    }

    let hasPendingKnown = false;
    let pendingKnown: { id: string; name: string; words: string[] } | null = null;

    let hasPendingPrefs = false;
    let pendingPrefs: PreferencesValue | null = null;

    let hasPendingAnki = false;
    let pendingAnkiConfig: AnkiSyncConfig | null = null;
    let pendingAnkiSnapshot: AnkiSyncSnapshot | null = null;

    const pendingDecisionsSet = new Map<string, WordDecision>();
    const pendingDecisionsRemove = new Set<string>();

    const pendingQueuesSet = new Map<string, SessionQueueSnapshot>();
    const pendingQueuesRemove = new Set<string>();

    for (const record of pendingOutbox) {
      if (record.kind === "known.replace") {
        hasPendingKnown = true;
        const active = await readerStore.knownWords.getActive();
        pendingKnown = active
          ? { id: active.id, name: active.name, words: [...active.words] }
          : null;
      } else if (record.kind === "preferences.replace") {
        hasPendingPrefs = true;
        pendingPrefs = await readerStore.preferences.load();
      } else if (record.kind === "anki.replace") {
        hasPendingAnki = true;
        pendingAnkiConfig = await readerStore.ankiSync.loadConfig();
        pendingAnkiSnapshot = await readerStore.ankiSync.loadSnapshot();
      } else if (record.kind === "decision.set" && record.resourceId) {
        const decision = await readerStore.wordDecisions.get(record.resourceId);
        if (decision) {
          pendingDecisionsSet.set(record.resourceId, decision);
        }
        pendingDecisionsRemove.delete(record.resourceId);
      } else if (record.kind === "decision.remove" && record.resourceId) {
        pendingDecisionsRemove.add(record.resourceId);
        pendingDecisionsSet.delete(record.resourceId);
      } else if (record.kind === "queue.replace" && record.resourceId) {
        const queue = await localSyncStore.loadQueue(record.resourceId);
        if (queue) {
          pendingQueuesSet.set(record.resourceId, queue);
        }
        pendingQueuesRemove.delete(record.resourceId);
      } else if (record.kind === "queue.remove" && record.resourceId) {
        pendingQueuesRemove.add(record.resourceId);
        pendingQueuesSet.delete(record.resourceId);
      }
    }

    // Clear only canonical cached state. The outbox/device metadata and any dataset
    // payload needed by an unsynced upload/activation remain durable.
    if (remoteApplyStore.clearDomainCache) {
      await remoteApplyStore.clearDomainCache({ preserveDatasetIds });
    } else {
      await remoteApplyStore.clearAll();
    }
    if (localSyncStore.clearCachedDomainState) {
      await localSyncStore.clearCachedDomainState({ preserveDatasetIds });
    }

    await localSyncStore.setMeta({
      id: "current",
      deviceId: currentMeta.deviceId,
      bootstrapComplete: false,
      serverEventId: 0,
      lastSyncAt: null,
      ...(currentMeta.nextOutboxSequence !== undefined
        ? { nextOutboxSequence: currentMeta.nextOutboxSequence }
        : {}),
    });

    // Write the canonical cloud snapshot with mutation recording disabled.
    if (known) {
      await remoteApplyStore.knownWords.save(known.id, known.name, known.words);
    }
    await remoteApplyStore.wordDecisions.replaceAll(decisions);
    if (preferences) {
      await remoteApplyStore.preferences.save(preferences);
    }
    for (const queue of queues) {
      await localSyncStore.saveQueue(queue, queue.datasetId, false);
    }
    if (anki.config) {
      await remoteApplyStore.ankiSync.saveConfig(anki.config);
    }
    if (anki.snapshot) {
      await remoteApplyStore.ankiSync.replaceSnapshot(anki.snapshot);
    }

    for (const dataset of manifest.datasets) {
      if (remoteApplyStore.datasets.upsertMetadata) {
        await remoteApplyStore.datasets.upsertMetadata(dataset);
      }
    }

    if (manifest.activeDatasetId) {
      await ensureDatasetCached(manifest.activeDatasetId, cloud, remoteApplyStore);
      await remoteApplyStore.datasets.activate(manifest.activeDatasetId);
    }

    // Re-apply pending local intent on top of the canonical snapshot.
    for (const word of pendingDecisionsRemove) {
      await remoteApplyStore.wordDecisions.remove(word);
    }
    for (const decision of pendingDecisionsSet.values()) {
      await remoteApplyStore.wordDecisions.set(decision);
    }
    if (hasPendingKnown) {
      if (pendingKnown) {
        await remoteApplyStore.knownWords.save(
          pendingKnown.id,
          pendingKnown.name,
          pendingKnown.words,
        );
      } else {
        await remoteApplyStore.knownWords.clear?.();
      }
    }
    if (hasPendingPrefs) {
      if (pendingPrefs) {
        await remoteApplyStore.preferences.save(pendingPrefs);
      } else {
        await remoteApplyStore.preferences.clear?.();
      }
    }
    if (hasPendingAnki) {
      if (pendingAnkiConfig) {
        await remoteApplyStore.ankiSync.saveConfig(pendingAnkiConfig);
      } else {
        await remoteApplyStore.ankiSync.clear?.();
      }
      if (pendingAnkiSnapshot) {
        await remoteApplyStore.ankiSync.replaceSnapshot(pendingAnkiSnapshot);
      } else {
        await remoteApplyStore.ankiSync.replaceSnapshot(null);
      }
    }
    for (const datasetId of pendingQueuesRemove) {
      await localSyncStore.saveQueue(null, datasetId, false);
    }
    for (const queue of pendingQueuesSet.values()) {
      await localSyncStore.saveQueue(queue, queue.datasetId, false);
    }
    for (const datasetId of pendingRemovedDatasets) {
      await remoteApplyStore.datasets.remove(datasetId);
    }
    if (pendingActiveDatasetId) {
      await ensureDatasetCached(pendingActiveDatasetId, cloud, remoteApplyStore);
      await remoteApplyStore.datasets.activate(pendingActiveDatasetId);
    }

    // Workspace must describe the final overlaid local state, not the pre-replay
    // canonical active dataset.
    const finalActiveDatasetId = (await remoteApplyStore.datasets.getActive())?.id ?? null;
    const activeQueue = finalActiveDatasetId
      ? await localSyncStore.loadQueue(finalActiveDatasetId)
      : null;
    await localSyncStore.saveWorkspace({
      id: "current",
      activeDatasetId: finalActiveDatasetId,
      viewportStart: 0,
      queueMode: activeQueue && activeQueue.normalizedWords.length > 0 ? "normal" : "normal",
      updatedAt: now(),
    });

    // Mark bootstrap complete only after canonical state and all pending overlays are durable.
    const metaAfter = await localSyncStore.getMeta();
    await localSyncStore.setMeta({
      id: "current",
      deviceId: currentMeta.deviceId,
      bootstrapComplete: true,
      serverEventId: manifest.eventId,
      lastSyncAt: now(),
      ...(metaAfter.nextOutboxSequence !== undefined
        ? { nextOutboxSequence: metaAfter.nextOutboxSequence }
        : {}),
    });
  };

  if (options.writeBarrier) {
    await options.writeBarrier.runReconcile(performReconcile);
    return;
  }
  await performReconcile();
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const {
    cloud,
    localAppStore,
    remoteApplyStore,
    localSyncStore,
    now = () => new Date().toISOString(),
    intervalMs = 15_000,
    debounceMs = 250,
  } = options;

  let currentStatus: SyncStatus = { state: "idle", pending: 0, lastSyncAt: null };
  const subscribers = new Set<(status: SyncStatus) => void>();
  const remoteAppliedListeners = new Set<() => Promise<void> | void>();

  let running: Promise<void> | null = null;
  let queued = false;

  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let onlineHandler: (() => void) | null = null;
  let visibilityHandler: (() => void) | null = null;

  function setStatus(next: SyncStatus) {
    currentStatus = next;
    for (const sub of subscribers) {
      try {
        sub(currentStatus);
      } catch (err) {
        console.error("SyncStatus subscriber error:", err);
      }
    }
  }

  function recordSyncTiming(stage: "sync_push" | "sync_pull", durationMs: number): void {
    if (typeof window !== "undefined") {
      const target = window as unknown as {
        __syncTimingEvents?: Array<{ stage: string; durationMs: number }>;
      };
      target.__syncTimingEvents = target.__syncTimingEvents ?? [];
      target.__syncTimingEvents.push({ stage, durationMs });
    }
  }

  async function pushUntilDrained(): Promise<void> {
    const pushStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const meta = await localSyncStore.getMeta();
      const deviceId = meta.deviceId;

      while (true) {
        const outbox = await localSyncStore.listOutbox(100);
        if (outbox.length === 0) break;

        const pendingUpload = outbox.find((record) => record.kind === "dataset.upload");
        if (pendingUpload) {
          const activatesPendingUpload = outbox.some(
            (record) =>
              record.kind === "dataset.activate" &&
              (record.resourceId === pendingUpload.resourceId || !record.resourceId),
          );

          if (outbox[0] === pendingUpload || activatesPendingUpload) {
            const datasetId = pendingUpload.resourceId!;
            const datasets = await localAppStore.datasets.list();
            const datasetMeta = datasets.find((d) => d.id === datasetId);

            if (!datasetMeta) {
              await localSyncStore.acknowledge(pendingUpload.dedupeKey, pendingUpload.mutationId);
              continue;
            }

            const chunks = localAppStore.datasets.readChunks(datasetId, 2000);
            const receipt = await cloud.uploadDataset(
              deviceId,
              pendingUpload.mutationId,
              datasetMeta,
              chunks,
            );

            if (receipt.acceptedMutationIds.includes(pendingUpload.mutationId)) {
              await localSyncStore.acknowledge(pendingUpload.dedupeKey, pendingUpload.mutationId);
            } else {
              break;
            }
            continue;
          }
        }

        const batchRecords: SyncOutboxRecord[] = [];
        for (const record of outbox) {
          if (record.kind === "dataset.upload") break;
          if (
            record.kind === "dataset.activate" &&
            outbox.some((u) => u.kind === "dataset.upload" && u.resourceId === record.resourceId)
          ) {
            break;
          }
          batchRecords.push(record);
        }

        const mutations: MaterializedSyncMutation[] = [];
        for (const record of batchRecords) {
          switch (record.kind) {
            case "dataset.remove":
              mutations.push({
                mutationId: record.mutationId,
                kind: "dataset.remove",
                datasetId: record.resourceId!,
              });
              break;

            case "dataset.activate": {
              const activeMeta = await localAppStore.datasets.getActive();
              mutations.push({
                mutationId: record.mutationId,
                kind: "dataset.activate",
                datasetId: activeMeta?.id ?? null,
              });
              break;
            }

            case "known.replace": {
              const activeKnown = await localAppStore.knownWords.getActive();
              mutations.push({
                mutationId: record.mutationId,
                kind: "known.replace",
                value: activeKnown
                  ? { id: activeKnown.id, name: activeKnown.name, words: [...activeKnown.words] }
                  : null,
              });
              break;
            }

            case "decision.set": {
              const decision = await localAppStore.wordDecisions.get(record.resourceId!);
              if (decision) {
                mutations.push({
                  mutationId: record.mutationId,
                  kind: "decision.set",
                  decision,
                });
              } else {
                mutations.push({
                  mutationId: record.mutationId,
                  kind: "decision.remove",
                  normalizedWord: record.resourceId!,
                });
              }
              break;
            }

            case "decision.remove":
              mutations.push({
                mutationId: record.mutationId,
                kind: "decision.remove",
                normalizedWord: record.resourceId!,
              });
              break;

            case "preferences.replace": {
              const prefs = await localAppStore.preferences.load();
              mutations.push({
                mutationId: record.mutationId,
                kind: "preferences.replace",
                value: prefs,
              });
              break;
            }

            case "queue.replace":
            case "queue.remove": {
              const queue = await localSyncStore.loadQueue(record.resourceId!);
              if (queue) {
                mutations.push({
                  mutationId: record.mutationId,
                  kind: "queue.replace",
                  value: queue,
                });
              } else {
                mutations.push({
                  mutationId: record.mutationId,
                  kind: "queue.remove",
                  datasetId: record.resourceId!,
                });
              }
              break;
            }

            case "anki.replace": {
              const config = await localAppStore.ankiSync.loadConfig();
              const snapshot = await localAppStore.ankiSync.loadSnapshot();
              mutations.push({
                mutationId: record.mutationId,
                kind: "anki.replace",
                config,
                snapshot,
              });
              break;
            }
          }
        }

        if (mutations.length === 0) {
          for (const rec of batchRecords) {
            await localSyncStore.acknowledge(rec.dedupeKey, rec.mutationId);
          }
          continue;
        }

        const receipt = await cloud.push(deviceId, mutations);

        let acceptedCount = 0;
        for (const record of batchRecords) {
          if (receipt.acceptedMutationIds.includes(record.mutationId)) {
            await localSyncStore.acknowledge(record.dedupeKey, record.mutationId);
            acceptedCount++;
          }
        }

        if (acceptedCount === 0) {
          break;
        }
      }
    } finally {
      recordSyncTiming(
        "sync_push",
        Math.round(
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - pushStart,
        ),
      );
    }
  }

  async function pullUntilCaughtUp(): Promise<void> {
    const pullStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      while (true) {
        const meta = await localSyncStore.getMeta();
        const page = await cloud.pull(meta.serverEventId, 200);

        if (page.changes.length === 0) {
          if (page.nextEventId !== meta.serverEventId) {
            await localSyncStore.setMeta({
              ...meta,
              serverEventId: page.nextEventId,
              lastSyncAt: now(),
            });
          }
          break;
        }

        for (const change of page.changes) {
          switch (change.kind) {
            case "decision.set":
              await remoteApplyStore.wordDecisions.set(change.decision);
              break;

            case "decision.remove":
              await remoteApplyStore.wordDecisions.remove(change.normalizedWord);
              break;

            case "preferences.replace":
              if (change.value === null) {
                await remoteApplyStore.preferences.clear?.();
              } else {
                await remoteApplyStore.preferences.save(change.value);
              }
              break;

            case "dataset.upsert":
              if (remoteApplyStore.datasets.upsertMetadata) {
                await remoteApplyStore.datasets.upsertMetadata(change.dataset);
              }
              break;

            case "dataset.remove":
              await remoteApplyStore.datasets.remove(change.datasetId);
              break;

            case "dataset.activate":
              if (change.datasetId !== null) {
                await ensureDatasetCached(change.datasetId, cloud, remoteApplyStore);
                await remoteApplyStore.datasets.activate(change.datasetId);
              }
              break;

            case "known.replace": {
              const canonicalKnown = await cloud.readKnownWords();
              if (canonicalKnown) {
                await remoteApplyStore.knownWords.save(
                  canonicalKnown.id,
                  canonicalKnown.name,
                  canonicalKnown.words,
                );
              } else {
                await remoteApplyStore.knownWords.clear?.();
              }
              break;
            }

            case "queue.replace": {
              const queues = await cloud.readQueues();
              const q =
                queues.find((candidate) => candidate.datasetId === change.datasetId) ?? null;
              await localSyncStore.saveQueue(q, change.datasetId, false);
              break;
            }

            case "queue.remove":
              await localSyncStore.saveQueue(null, change.datasetId, false);
              break;

            case "anki.replace": {
              const canonicalAnki = await cloud.readAnki();
              if (canonicalAnki.config) {
                await remoteApplyStore.ankiSync.saveConfig(canonicalAnki.config);
              } else {
                await remoteApplyStore.ankiSync.clear();
              }
              if (canonicalAnki.snapshot) {
                await remoteApplyStore.ankiSync.replaceSnapshot(canonicalAnki.snapshot);
              } else {
                await remoteApplyStore.ankiSync.replaceSnapshot(null);
              }
              break;
            }

            case "full-reset":
              await bootstrapLocalCache({
                cloud,
                remoteApplyStore,
                localSyncStore,
                localAppStore,
                now,
                writeBarrier: options.writeBarrier,
              });
              break;
          }
        }

        for (const listener of remoteAppliedListeners) {
          await listener();
        }

        const currentMeta = await localSyncStore.getMeta();
        await localSyncStore.setMeta({
          ...currentMeta,
          serverEventId: page.nextEventId,
          lastSyncAt: now(),
        });

        if (page.nextEventId <= meta.serverEventId) {
          break;
        }
      }
    } finally {
      recordSyncTiming(
        "sync_pull",
        Math.round(
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - pullStart,
        ),
      );
    }
  }

  async function executeSyncLoop(): Promise<void> {
    const meta = await localSyncStore.getMeta();
    const pendingRecords = await localSyncStore.listOutbox(100);

    setStatus({
      state: "syncing",
      pending: pendingRecords.length,
      lastSyncAt: meta.lastSyncAt,
    });

    try {
      await pushUntilDrained();
      await pullUntilCaughtUp();

      const updatedMeta = await localSyncStore.getMeta();
      const nowIso = now();
      await localSyncStore.setMeta({ ...updatedMeta, lastSyncAt: nowIso });

      const remainingOutbox = await localSyncStore.listOutbox(100);
      setStatus({
        state: "idle",
        pending: remainingOutbox.length,
        lastSyncAt: nowIso,
      });
    } catch (error: unknown) {
      const isNetwork =
        (error instanceof RemoteStoreError && error.code === "NETWORK_ERROR") ||
        (typeof navigator !== "undefined" && !navigator.onLine);
      const updatedMeta = await localSyncStore.getMeta();
      const remainingOutbox = await localSyncStore.listOutbox(100);

      if (isNetwork) {
        setStatus({
          state: "offline",
          pending: remainingOutbox.length,
          lastSyncAt: updatedMeta.lastSyncAt,
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        setStatus({
          state: "error",
          pending: remainingOutbox.length,
          lastSyncAt: updatedMeta.lastSyncAt,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  async function syncNow(): Promise<void> {
    if (running) {
      queued = true;
      return running;
    }

    running = (async () => {
      try {
        do {
          queued = false;
          await executeSyncLoop();
        } while (queued);
      } finally {
        running = null;
      }
    })();

    return running;
  }

  async function flush(): Promise<void> {
    if (running) {
      await running;
    } else {
      await pushUntilDrained();
    }
    const remaining = await localSyncStore.listOutbox(1);
    if (remaining.length > 0) {
      await pushUntilDrained();
      const finalRemaining = await localSyncStore.listOutbox(1);
      if (finalRemaining.length > 0) {
        throw new Error("Flush failed: outbox is not empty");
      }
    }
  }

  function notifyOutbox(): void {
    void localSyncStore.listOutbox(100).then((pendingRecords) => {
      if (pendingRecords.length > 0 && currentStatus.state === "idle") {
        setStatus({
          ...currentStatus,
          pending: pendingRecords.length,
        });
      }
    });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void syncNow().catch(() => {});
    }, debounceMs);
  }

  function start(): void {
    if (typeof window !== "undefined") {
      onlineHandler = () => {
        void syncNow().catch(() => {});
      };
      window.addEventListener("online", onlineHandler);

      visibilityHandler = () => {
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
          void syncNow().catch(() => {});
        }
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", visibilityHandler);
      }

      intervalTimer = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          void syncNow().catch(() => {});
        }
      }, intervalMs);
    }
  }

  function dispose(): void {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (typeof window !== "undefined" && onlineHandler) {
      window.removeEventListener("online", onlineHandler);
      onlineHandler = null;
    }
    if (typeof document !== "undefined" && visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
  }

  return {
    start,
    syncNow,
    flush,
    ensureDatasetCached: (datasetId: string) =>
      ensureDatasetCached(datasetId, cloud, remoteApplyStore),
    subscribe(listener: (status: SyncStatus) => void): () => void {
      subscribers.add(listener);
      listener(currentStatus);
      return () => {
        subscribers.delete(listener);
      };
    },
    onRemoteApplied(listener: () => Promise<void> | void): () => void {
      remoteAppliedListeners.add(listener);
      return () => {
        remoteAppliedListeners.delete(listener);
      };
    },
    notifyOutbox,
    dispose,
  };
}
