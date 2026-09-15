# Next.js and PostgreSQL migration

Status: proposed for owner review. Implementation has not started.

## Outcome

Replace the Vite application with a Next.js App Router application deployable to Vercel. PostgreSQL is the authoritative store. This is a private, single-owner application, as requested. Preserve the current visual design and vocabulary workflows.

## Approach and alternatives

Recommended: rewrite the interface as React components, introduce authenticated Next.js server endpoints and a PostgreSQL persistence layer, and retain tested parsing, decision, coverage, worker, and Migaku integration algorithms where appropriate. This delivers a maintainable Next.js application without changing vocabulary semantics unnecessarily.

A Next.js wrapper around the existing imperative DOM application would be quicker but would retain most of the old application structure. A fully server-driven query engine would avoid downloading datasets but would add substantial complexity to interactive practice and filtering. Neither is the recommended migration.

## Access and deployment

Use GitHub OAuth sign-in with an explicit server-side allowlist containing the owner's immutable GitHub account ID. Reject all other identities. Every data endpoint must verify the session and owner; a protected page alone is insufficient. Use secure HTTP-only session cookies and origin protection for mutations. Never expose database or OAuth secrets to client code.

Use Drizzle for PostgreSQL schema and versioned migrations. Support a standard DATABASE_URL and a pooled production connection; recommend Neon through Vercel Marketplace. Provide a local PostgreSQL development setup. Database provisioning and OAuth application registration require real user-owned credentials. Deliver example environment variables and exact setup instructions; do not invent credentials or provision paid resources.

## Application structure

Next.js app routes own the layout, login, miner page, loading/error states, and authenticated API. Move existing application services out of src/app to avoid collision with Next.js route conventions. Organize React components by import, results, filters, review, practice, queue, coverage, settings, and Anki sync. Keep pure domain logic independent of React and PostgreSQL.

Retain a browser worker for CSV parsing and interactive query/coverage calculations. Keep large result lists windowed. Provide a carefully bounded DOM surface for Migaku extension parsing and non-mutating highlighting; React must not repeatedly overwrite extension-managed sentence content.

## Data model

Store datasets and ordered entries, active dataset selection, known words, manual word decisions, preferences, per-dataset mining queue, Anki configuration, and Anki snapshot in PostgreSQL. Use dataset foreign keys and uniqueness constraints for entries and normalized words. Store structured preferences and furigana runs as validated JSON where useful. The queue becomes durable across sessions.

Uploads use bounded batches with a staging identifier, validated byte and row limits, and idempotent chunk numbering. Activate a dataset transactionally only after all expected chunks are present and verified. A failed upload leaves the previous dataset active. Reads are paginated/chunked so a 100,000-row dataset never requires one oversized function response. Abandoned staging records have a documented cleanup mechanism.

Mutations return saved state or a clear error. Do not silently switch to temporary browser storage on database failures. Serialize dependent client mutations and use revision checks for bulk replacement so stale tabs cannot overwrite newer state unnoticed. Restore and clear operations are transactional. User-confirmed deletion remains scoped to application data.

## Feature parity

Preserve CSV and Migaku TXT import, all filters and sorting, pagination and windowed all-results, reading/display controls, review keyboard controls and undo, practice mode, queue, coverage targets, backup import/export, and manual-over-Anki decision precedence. Preserve read-only Anki scan, preview, apply, and clear workflows.

AnkiConnect calls remain browser-to-localhost. Document required origin permissions and browser local-network restrictions. Display actionable failures when Anki is unavailable; retain the last saved snapshot. Never route localhost calls through Vercel.

Replace automatic local-folder discovery with explicit uploads. A cloud origin cannot access the old local browser database. Migration instructions require exporting the existing version 1/2 backup and reimporting the original CSV on the new app. Existing backups do not include datasets or the session queue; document that limitation. Continue accepting legacy backups and provide a new complete backup format including datasets and queue, transferred in bounded requests when restoring.

The deployed app requires a network connection for persistence. Full offline synchronization is outside this migration. Keep old local data intact until the owner verifies migration.

## Verification and delivery

Run retained domain and worker suites. Add PostgreSQL integration tests for staging/activation, failed imports, transactional restore, durable queue, revision conflicts, and owner access enforcement. Adapt browser tests for authenticated Next.js sessions and real persistence; test reload, review, practice, Migaku highlighting, Anki mocks, backups, and the 100,000-row scenario. Verify production build and production-server browser flows, as well as unauthenticated and non-owner rejection.

Replace Vite-specific scripts and obsolete launcher documentation with Next.js development/build/start, schema migration, and Vercel setup instructions. Preserve legacy bookmark redirects. Document all required environment variables, migration order, backup/rollback steps, and any verification blocked by unavailable external credentials. Live deployment is a separate action from making the code deployable.
