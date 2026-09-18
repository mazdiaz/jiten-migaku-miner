import type { AnkiSyncConfig, AnkiSyncSnapshot, AnkiWordStatus } from "../domain/anki";
import type { Entry, WordDecision } from "../domain/types";
import type { DatasetMetadata } from "../storage/contracts";
import { RemoteStoreError } from "../storage/remote-store";
import { splitEntriesForWire } from "./batching";
import type {
  CloudBootstrapManifest,
  CloudSyncPort,
  MaterializedSyncMutation,
  PreferencesValue,
  SessionQueueSnapshot,
  SyncPullPage,
  SyncPushReceipt,
} from "./contracts";

export function createCloudSyncClient(
  endpoint = "/api/sync",
  transport: typeof fetch = fetch,
): CloudSyncPort {
  async function request<T>(payload: unknown): Promise<T> {
    let response: Response;
    try {
      response = await transport(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
    } catch {
      throw new RemoteStoreError(
        "Could not reach saved data. Check your connection and reload before continuing.",
        0,
        "NETWORK_ERROR",
      );
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new RemoteStoreError(
        "The server returned an invalid response. Reload before continuing.",
        response.status,
        "INVALID_RESPONSE",
      );
    }

    if (!response.ok) {
      const errorObj =
        typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
      throw new RemoteStoreError(
        typeof errorObj?.error === "string" ? errorObj.error : "Could not save or load data.",
        response.status,
        typeof errorObj?.code === "string" ? errorObj.code : "SERVER_ERROR",
      );
    }

    return result as T;
  }

  return {
    async bootstrap(): Promise<CloudBootstrapManifest> {
      return await request<CloudBootstrapManifest>({ operation: "bootstrap" });
    },

    async readKnownWords(): Promise<{ id: string; name: string; words: string[] } | null> {
      let cursor = 0;
      const words: string[] = [];
      let header: { id: string; name: string } | null = null;

      while (true) {
        const page = await request<{
          id: string;
          name: string;
          items: string[];
          nextCursor: number | null;
        } | null>({
          operation: "state.read",
          resource: "knownWords",
          cursor,
        });

        if (page === null) return null;
        if (!header) {
          header = { id: page.id, name: page.name };
        }
        words.push(...page.items);

        if (page.nextCursor === null) {
          return { id: header.id, name: header.name, words };
        }
        if (page.nextCursor <= cursor) {
          throw new RemoteStoreError(
            "The server returned an invalid page.",
            502,
            "INVALID_RESPONSE",
          );
        }
        cursor = page.nextCursor;
      }
    },

    async readDecisions(): Promise<WordDecision[]> {
      let cursor = 0;
      const decisions: WordDecision[] = [];

      while (true) {
        const page = await request<{ items: WordDecision[]; nextCursor: number | null }>({
          operation: "state.read",
          resource: "decisions",
          cursor,
        });

        decisions.push(...page.items);
        if (page.nextCursor === null) {
          return decisions;
        }
        if (page.nextCursor <= cursor) {
          throw new RemoteStoreError(
            "The server returned an invalid page.",
            502,
            "INVALID_RESPONSE",
          );
        }
        cursor = page.nextCursor;
      }
    },

    async readPreferences(): Promise<PreferencesValue | null> {
      return await request<PreferencesValue | null>({
        operation: "state.read",
        resource: "preferences",
        cursor: 0,
      });
    },

    async readQueues(): Promise<SessionQueueSnapshot[]> {
      let cursor = 0;
      const datasetIds: string[] = [];

      while (true) {
        const page = await request<{ items: string[]; nextCursor: number | null }>({
          operation: "state.read",
          resource: "queues",
          cursor,
        });

        datasetIds.push(...page.items);
        if (page.nextCursor === null) break;
        if (page.nextCursor <= cursor) {
          throw new RemoteStoreError(
            "The server returned an invalid page.",
            502,
            "INVALID_RESPONSE",
          );
        }
        cursor = page.nextCursor;
      }

      const queues: SessionQueueSnapshot[] = [];
      for (const datasetId of datasetIds) {
        let qCursor = 0;
        const words: string[] = [];

        while (true) {
          const qPage = await request<{
            version: 1;
            datasetId: string;
            items: string[];
            nextCursor: number | null;
          } | null>({
            operation: "state.read",
            resource: "queue",
            datasetId,
            cursor: qCursor,
          });

          if (qPage === null) break;
          words.push(...qPage.items);

          if (qPage.nextCursor === null) {
            queues.push({
              version: 1,
              datasetId: qPage.datasetId,
              normalizedWords: words,
            });
            break;
          }
          if (qPage.nextCursor <= qCursor) {
            throw new RemoteStoreError(
              "The server returned an invalid page.",
              502,
              "INVALID_RESPONSE",
            );
          }
          qCursor = qPage.nextCursor;
        }
      }

      return queues;
    },

    async readAnki(): Promise<{
      config: AnkiSyncConfig | null;
      snapshot: AnkiSyncSnapshot | null;
    }> {
      const config = await request<AnkiSyncConfig | null>({
        operation: "state.read",
        resource: "ankiConfig",
        cursor: 0,
      });

      let cursor = 0;
      const statuses: [string, AnkiWordStatus][] = [];
      let syncedAt: string | null = null;
      let snapshot: AnkiSyncSnapshot | null = null;

      while (true) {
        const page = await request<{
          syncedAt: string;
          items: [string, AnkiWordStatus][];
          nextCursor: number | null;
        } | null>({
          operation: "state.read",
          resource: "ankiSnapshot",
          cursor,
        });

        if (page === null) {
          snapshot = null;
          break;
        }
        if (syncedAt === null) {
          syncedAt = page.syncedAt;
        }
        statuses.push(...page.items);

        if (page.nextCursor === null) {
          snapshot = {
            syncedAt: syncedAt!,
            statuses,
          };
          break;
        }
        if (page.nextCursor <= cursor) {
          throw new RemoteStoreError(
            "The server returned an invalid page.",
            502,
            "INVALID_RESPONSE",
          );
        }
        cursor = page.nextCursor;
      }

      return { config, snapshot };
    },

    async pull(afterEventId: number, limit?: number): Promise<SyncPullPage> {
      return await request<SyncPullPage>({
        operation: "pull",
        afterEventId,
        ...(limit !== undefined ? { limit } : {}),
      });
    },

    async push(
      deviceId: string,
      mutations: readonly MaterializedSyncMutation[],
    ): Promise<SyncPushReceipt> {
      return await request<SyncPushReceipt>({
        operation: "push",
        deviceId,
        mutations: mutations as MaterializedSyncMutation[],
      });
    },

    async uploadDataset(
      deviceId: string,
      mutationId: string,
      metadata: DatasetMetadata,
      chunks: AsyncIterable<readonly Entry[]>,
    ): Promise<SyncPushReceipt> {
      const beginResult = await request<{
        uploadId: string;
        alreadyReady?: boolean;
        receipt?: SyncPushReceipt;
      }>({
        operation: "dataset.begin",
        deviceId,
        mutationId,
        metadata,
      });

      if (beginResult.alreadyReady && beginResult.receipt) {
        return beginResult.receipt;
      }

      if (beginResult.alreadyReady) {
        return await request<SyncPushReceipt>({
          operation: "dataset.finish",
          deviceId,
          mutationId,
          chunkCount: 0,
        });
      }

      let chunkCount = 0;
      for await (const chunk of chunks) {
        if (chunk.length === 0) continue;
        const subChunks = splitEntriesForWire(chunk);
        for (const subChunk of subChunks) {
          await request<{ ok: boolean }>({
            operation: "dataset.chunks",
            deviceId,
            mutationId,
            chunks: [{ index: chunkCount, entries: subChunk }],
          });
          chunkCount++;
        }
      }

      return await request<SyncPushReceipt>({
        operation: "dataset.finish",
        deviceId,
        mutationId,
        chunkCount,
      });
    },

    readDataset(datasetId: string, _chunkSize: number): AsyncIterable<Entry[]> {
      async function* readDatasetChunks(): AsyncGenerator<Entry[]> {
        let cursor = 0;
        while (true) {
          const page = await request<{ items: Entry[]; nextCursor: number | null }>({
            operation: "dataset.read",
            datasetId,
            cursor,
          });

          if (page.items.length > 0) {
            yield page.items;
          }
          if (page.nextCursor === null) {
            break;
          }
          if (page.nextCursor <= cursor) {
            throw new RemoteStoreError(
              "The server returned an invalid page.",
              502,
              "INVALID_RESPONSE",
            );
          }
          cursor = page.nextCursor;
        }
      }

      return readDatasetChunks();
    },
  };
}
