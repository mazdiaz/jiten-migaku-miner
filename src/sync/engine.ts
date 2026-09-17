import type { AppStore } from "../storage/contracts";
import type { LocalSyncStore } from "../storage/local-sync";
import type { CloudSyncPort } from "./contracts";

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
  now?: (() => string) | undefined;
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
  const now = options.now ?? (() => new Date().toISOString());

  // 1. Fetch cloud manifest & data first
  const manifest = await cloud.bootstrap();
  const known = await cloud.readKnownWords();
  const decisions = await cloud.readDecisions();
  const preferences = await cloud.readPreferences();
  const queues = await cloud.readQueues();
  const anki = await cloud.readAnki();

  // Clear incomplete new local-first cache before writing state
  const currentMeta = await localSyncStore.getMeta();
  await remoteApplyStore.clearAll();
  await localSyncStore.setMeta({
    id: "current",
    deviceId: currentMeta.deviceId,
    bootstrapComplete: false,
    serverEventId: 0,
    lastSyncAt: null,
  });

  // 2. Write state with recording-disabled local stores
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

  // 3. Upsert every dataset metadata as metadata-only
  for (const dataset of manifest.datasets) {
    if (remoteApplyStore.datasets.upsertMetadata) {
      await remoteApplyStore.datasets.upsertMetadata(dataset);
    }
  }

  // 4. If activeDatasetId != null: download/stage active dataset with recording disabled, then activate locally
  if (manifest.activeDatasetId) {
    await ensureDatasetCached(manifest.activeDatasetId, cloud, remoteApplyStore);
    await remoteApplyStore.datasets.activate(manifest.activeDatasetId);
  }

  // 5. Save active queue / workspace
  const activeQueue = manifest.activeDatasetId
    ? await localSyncStore.loadQueue(manifest.activeDatasetId)
    : null;
  await localSyncStore.saveWorkspace({
    id: "current",
    activeDatasetId: manifest.activeDatasetId,
    viewportStart: 0,
    queueMode: activeQueue && activeQueue.normalizedWords.length > 0 ? "normal" : "normal",
    updatedAt: now(),
  });

  // 6. Write sync meta bootstrapComplete=true/serverEventId=manifest.eventId LAST
  await localSyncStore.setMeta({
    id: "current",
    deviceId: currentMeta.deviceId,
    bootstrapComplete: true,
    serverEventId: manifest.eventId,
    lastSyncAt: now(),
  });
}
