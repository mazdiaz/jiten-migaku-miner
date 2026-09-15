# Next.js PostgreSQL Implementation Plan

> Execute using superpowers:subagent-driven-development with scoped ownership and review. Work in the existing checkout as requested by the owner.

**Goal:** Deliver the approved private Next.js/PostgreSQL migration in the current repository.
**Architecture:** React interface and client study engine; authenticated Next.js API; Drizzle/PostgreSQL storage. Preserve domain algorithms and extension-managed sentence DOM.
**Spec:** ../specs/2026-09-14-nextjs-postgres-design.md

## Global constraints

Single owner authenticated through GitHub ID. No new repository, live deployment, paid provisioning, or destructive migration of existing browser data. Keep all existing study features. Secrets stay server-side. No silent memory fallback for remote failures.

## Task 1: PostgreSQL persistence and wire protocol

- [x] Create src/server/db/schema.ts, src/server/db/client.ts, src/server/store.ts, src/storage/remote-store.ts, migrations, and tests/server/postgres-store.test.ts.
- [x] Expose a validated operation dispatcher independent of HTTP/auth, consumed by the authenticated API. Expose createRemoteAppStore() implementing existing AppStore. Dataset uploads and large user-state payloads use bounded staging chunks and atomic finalization. Revision mismatch rejects stale writes.
- [x] Test incomplete activation preserving old data, duplicate chunks, transactional restore, durable queue, invalid payloads, and stale revisions against PostgreSQL-compatible runtime, then implement and rerun.
- [x] Provide migration and staging cleanup scripts.

## Task 2: Next.js and owner authentication

- [x] Replace Vite scripts with Next.js and install React, Next.js, Drizzle, postgres, Zod, Auth.js, and test database dependencies.
- [x] Create owner policy tests: missing owner ID rejects; a different GitHub ID rejects; owner ID accepts. Implement server-side GitHub session enforcement for every persistence call.
- [x] Create src/app routes, errors, login/logout, origin-checked API, environment example, and redirects. Move src/app services to src/miner and update imports.
- [x] Verify unauthenticated API rejection and production build without provisioned database.

## Task 3: React study interface and durable queue

- [x] Convert the existing markup into focused React feature components. Wire controller lifecycle with cleanup, keeping Migaku-managed results isolated from React reconciliation.
- [x] Add persistence status and error reporting, remove folder discovery and browser fallback from cloud entry point, connect PostgreSQL adapter.
- [x] Test initialization/teardown, queue reload and failure handling, study flows, backups, and 100,000-row virtualization.

## Task 4: Complete backup and delivery

- [x] Preserve old backup parsers and add a complete backup including dataset and queue; restore through bounded staging and transactional activation.
- [x] Update documentation and launcher, migration instructions, Docker development database, environment/migration commands, and Vercel steps.
- [x] Run typecheck, unit/database tests, build, authenticated browser tests, and security review. Record external credential limitations accurately.

## Execution ledger

Ruling: work in current checkout — user explicitly requested an overhaul of the existing local folder and repository.
Baseline: 748/750 tests pass. Two number-format assertions fail under the host's Indonesian locale; fix deterministic English display formatting during UI integration.
Interface scan: task 1 produces AppStore adapter and dispatcher consumed by tasks 2/3; agree exact exported signatures with worker before integration. Task 4 uses same staging protocol as task 1. Tasks 2/3 own framework and interface files; task 1 owns storage/server database files. No shared implementation file edits during delegation.

## Final verification — 2026-09-15

Implemented in the existing checkout without creating a repository, committing, pushing, or provisioning a live deployment.

- Lint and TypeScript checks pass. Final Next.js production build passes without deployment credentials.
- Unit/database suite: 774 tests passed across 54 files, including PostgreSQL-compatible execution through PGlite, restore concurrency, UTF-16 chunk boundaries, export size limits, and import/backup error ordering.
- Full browser run against disposable PostgreSQL 17: 170/174 passed initially. Four failures exposed a startup timing assumption in a test and a backup-error refresh race. The affected flows and a new Firefox hydration regression were rerun across Chromium, Firefox, and WebKit: 17/18 passed; the remaining WebKit error race was reproduced in a unit test and fixed by invalidating stale import follow-up refreshes. All six final WebKit backup checks (each scenario repeated twice) pass. The full suite was not redundantly rerun after these scoped fixes.
- 100,000-row import and bounded DOM checks passed in all three browsers: approximately 19 seconds in Chromium/Firefox and 23 seconds in WebKit on this machine.
- Final production smoke tests: 2/2 passed, covering import/reload persistence, legacy redirects, and private-file protection.
- Migration reapplied safely and abandoned-upload cleanup retained saved data. Final fresh test database migration passed.
- Production dependency audit found no reported vulnerabilities. Scoped independent security/storage review passed after all three review findings were resolved; see the separate review report.

External setup remaining: configure a real PostgreSQL connection, GitHub OAuth app, owner ID, auth secret and public origin on Vercel; apply migrations and deploy. Real GitHub authorization and Anki Desktop/extension integration require the owner's configured environment. README contains deployment and old-data migration instructions. Existing browser data was not deleted.