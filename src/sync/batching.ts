import type { Entry } from "../domain/types";
import { RemoteStoreError } from "../storage/remote-store";

export const MAX_SYNC_ROW_BYTES = 400_000;
export const MAX_SYNC_CHUNK_BODY_BYTES = 650_000;
export const MAX_SYNC_BATCH_ROWS = 2_000;

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function splitEntriesForWire(
  entries: readonly Entry[],
  maxRows: number = MAX_SYNC_BATCH_ROWS,
  maxBytes: number = MAX_SYNC_CHUNK_BODY_BYTES,
): Entry[][] {
  const batches: Entry[][] = [];
  let currentBatch: Entry[] = [];
  let currentBatchBytes = 150;

  for (const entry of entries) {
    const entryBytes = byteLength(entry) + 1;
    if (entryBytes > MAX_SYNC_ROW_BYTES) {
      throw new RemoteStoreError(
        "One dataset row exceeds the 400 KB size limit.",
        413,
        "PAYLOAD_TOO_LARGE",
      );
    }

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxRows || currentBatchBytes + entryBytes > maxBytes)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchBytes = 150;
    }

    currentBatch.push(entry);
    currentBatchBytes += entryBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
