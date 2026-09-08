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
  if (error instanceof StorageUnavailableError) {
    // Adapter wrappers may preserve the browser's original DOMException as
    // the cause. In that case classify the cause, not the wrapper label, so
    // application/data errors such as ConstraintError or DataError never
    // become fallback-eligible merely because they crossed the adapter.
    if (error.cause !== undefined) return isStorageUnavailableError(error.cause);

    // A transaction-level error with no exposed cause is ambiguous: browsers
    // (and fake-indexeddb) can dispatch the transaction error event before
    // transaction.error is populated. Failing closed here avoids silently
    // switching to memory for a data/application error such as ConstraintError.
    // Explicit backend-unavailable wrappers (open blocked, no IndexedDB, etc.)
    // use different messages and remain fallback-eligible.
    if (/^IndexedDB transaction (?:failed|aborted)(?::|$)/.test(error.message)) return false;
    return true;
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return UNAVAILABLE_DOM_EXCEPTION_NAMES.has(error.name);
  }
  if (error instanceof TypeError || error instanceof ReferenceError) {
    // Embeddings without any storage implementation reject on first access.
    return /indexeddb/i.test(error.message);
  }
  return false;
}
