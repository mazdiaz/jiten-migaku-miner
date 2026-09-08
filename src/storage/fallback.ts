export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageUnavailableError";
  }
}

// DOMException names raised by the browser itself when the storage backend
// cannot be used at all: blocked access (private mode / security policy),
// a broken or deleted database, storage pressure, or schema version skew
// that leaves the database unopenable. Deliberately narrow — do not add
// names without a reproducible browser scenario and a test.
const UNAVAILABLE_DOM_EXCEPTION_NAMES = new Set([
  "SecurityError",
  "InvalidStateError",
  "UnknownError",
  "QuotaExceededError",
  "VersionError",
  "NotFoundError",
]);

/**
 * Decides whether a storage failure means "the backend is unavailable or
 * unusable" (eligible for the automatic memory fallback) versus an
 * application/domain invariant failure (which must surface instead of
 * silently switching stores and hiding the defect).
 */
export function isStorageUnavailableError(error: unknown): boolean {
  if (error instanceof StorageUnavailableError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return UNAVAILABLE_DOM_EXCEPTION_NAMES.has(error.name);
  }
  if (error instanceof TypeError || error instanceof ReferenceError) {
    // Embeddings without any storage implementation reject on first access.
    return /indexeddb/i.test(error.message);
  }
  return false;
}
