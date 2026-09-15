# Jiten → Migaku Miner

A private Japanese vocabulary workspace built with **Next.js 16, React 19, and PostgreSQL**. Import Jiten CSV and Migaku known-word TXT files, review and practice vocabulary, build a mining queue, and keep progress across devices.

This is the existing repository migrated from Vite. Vocabulary parsing, study rules, Web Worker processing, and Migaku-compatible sentence highlighting retain their tested behavior.

## Deploy to Vercel

1. Import this existing GitHub repository into Vercel. Select **Next.js** and use the repository root as the Root Directory. Keep the build command `npm run build`; leave Output Directory at the framework default. Use Node.js 22 or 24.
2. Create/connect a PostgreSQL database, such as [Neon through Vercel Marketplace](https://vercel.com/integrations/neon). Set `DATABASE_URL` to its pooled connection string, including the provider's TLS settings. Keep production and preview databases separate.
3. Register a [GitHub OAuth App](https://github.com/settings/developers). Set its homepage to your production origin and callback URL to `https://YOUR-DOMAIN/api/auth/callback/github`. Use a separate OAuth app for local development.
4. Configure these **server-only** Vercel environment variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | PostgreSQL connection string |
   | `AUTH_SECRET` | Random secret, generated with the command below |
   | `AUTH_GITHUB_ID` | GitHub OAuth client ID |
   | `AUTH_GITHUB_SECRET` | GitHub OAuth client secret |
   | `OWNER_GITHUB_ID` | Your numeric GitHub account ID; `46370875` for mazdiaz |
   | `AUTH_URL` | Exact public origin, such as `https://miner.example.com` |
   | `AUTH_TRUST_HOST` | `true` on Vercel |

5. Apply the migrations to that database **before using the deployed app**. From a trusted terminal, set `DATABASE_URL` to the deployment database and run `npm run db:migrate`. On a local machine you can put it in the ignored `.env.local`. The migration command also works with environment variables alone. It is safe to rerun and refuses changes to previously applied migration files.
6. Deploy/redeploy, open the site, and sign in with the allowed GitHub account. All other accounts are rejected. Database access is checked again on every API request.

Generate a secret:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

No database, OAuth application, or live Vercel deployment is provisioned by this repository. Do not put secrets in `NEXT_PUBLIC_*` variables. Use a stable domain for the OAuth callback; random preview URLs need their own correctly configured callback and database.

## Run locally

Requires Node.js **22.12+** and PostgreSQL 17+ (or the Docker configuration included here).

```sh
npm ci
```

Copy `.env.example` to `.env.local`, then fill in the authentication values. Start a local database:

```sh
docker compose up -d
npm run db:migrate
npm run dev
```

Open [http://127.0.0.1:8920](http://127.0.0.1:8920). Set the local OAuth callback to `http://127.0.0.1:8920/api/auth/callback/github`. Use that exact address consistently; `localhost` is a different origin.

For a local production build:

```sh
npm run build
npm start
```

Windows users can run `start-miner.bat` after setting up `.env.local` and PostgreSQL. It builds and starts Next.js. It does not initialize or replace database contents.

## Move existing local data

The deployed site cannot read IndexedDB belonging to your old local site.

1. In the **old app**, export a backup and retain your original Jiten CSV and Migaku TXT files. Do this before switching your local launcher to this version. If already switched, the old app can be recovered from Git history without deleting browser data.
2. Sign in to the new app, import the original Jiten CSV, and restore the old backup.
3. Version 1/2 backups restore known words, decisions, preferences, and supported Anki data. They do **not** contain Jiten datasets or the old session queue. Recreate that queue manually if needed.
4. Compare the visible counts and decisions, then export a **new complete backup**. Version 3 includes saved datasets, the active dataset, mining queues, known words, decisions, preferences, and Anki state.

Old browser storage is not deleted by this migration. Keep the old backup until you have verified the new data. A complete restore replaces the application's saved state atomically; export first if you want to preserve the current state.

## Features and behavior

- Jiten CSV import and optional Migaku known-word TXT import.
- Search, occurrence sorting, known/kana/sentence/decision filters, paging, and windowed all-results mode.
- One-card review with K/M/S/L, undo, practice/reveal mode, and a mining queue saved in PostgreSQL.
- Vocabulary coverage and target estimates, reading size/density, definitions, furigana, and target highlighting.
- Manual decisions take precedence over Anki-derived decisions. Migaku knownness remains independent.
- Read-only Anki scan, preview, apply, and persisted snapshot; no Anki card-editing operations.
- Legacy bookmark paths redirect to the new root page.

The cloud app requires a connection for persistence. Wait for **Saved to PostgreSQL** before closing the page. Pending operations show a syncing state; leaving during a pending save prompts for confirmation. A lost connection or stale tab shows an error and requires a reload rather than silently switching to temporary storage. If a network failure occurs during a save/restore, reload to see whether it committed before retrying.

Local folder discovery has been replaced by explicit uploads. Private vocabulary folders, repository files, and secrets are not served by Next.js.

## AnkiConnect

Anki Desktop must be running on the **same computer as your browser**, with AnkiConnect at `http://127.0.0.1:8765`. The browser calls it directly; Vercel never connects to localhost on your behalf.

Allow the exact app origin in AnkiConnect's `webCorsOriginList`, and grant browser local-network permission if requested. HTTPS-to-loopback access depends on browser settings and policy. If your browser blocks it, use the saved Anki snapshot or a supported local-browser setup. The app remains usable with Anki closed. Never expose AnkiConnect to the public internet.

## Database and operational limits

Drizzle defines the schema; parameterized SQL and transactions implement storage. Numbered SQL migrations in `migrations/` are applied with a checksum ledger and an advisory lock. Add a new numbered SQL file for future schema changes; never edit an applied migration.

Dataset and state uploads are staged in bounded requests below 750 KB. Dataset rows are validated, ordered, and verified before activation. The prior active dataset remains available on a failed import. Reads are chunked as well. Complete restores commit in one transaction, and revision checks reject stale writes and mixed-version exports.

Limits: up to 1,000,000 rows per dataset, 400 KB per individual row, and 256 MiB per staged state upload/complete backup file. The browser's practical memory budget may be lower. The automated performance scenario exercises 100,000 rows. Complete exports exceeding the restore limit fail visibly instead of producing an unusable backup.

Run this occasionally to remove abandoned uploads older than 24 hours:

```sh
npm run db:cleanup
```

It retains ready datasets and active data. Database backups and provider restore points are also useful before deployments. Preview deployments must not share the production database. The app intentionally supports one owner per deployment.

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Unit tests include real PostgreSQL execution through PGlite for storage, revision conflicts, staging, Unicode boundaries, and atomic restore. Browser tests use a **disposable PostgreSQL database** and real authenticated sessions. They clear application data in that database before each test, so never point them at your personal or production database.

Set `TEST_DATABASE_URL` to the disposable database, apply migrations with `DATABASE_URL` pointing to it, then run:

```sh
npx playwright install chromium firefox webkit
npm run test:e2e
npm run build
npm run test:e2e:prod
```

Browser tests mint sessions with a test-only secret passed to their own server; there is no authentication bypass in the application. CI starts its own PostgreSQL service. GitHub's external authorization flow and an actual Anki Desktop installation still require validation with your configured accounts and browser.

## Structure

- `src/app/`: Next.js pages, authentication endpoint, authenticated storage endpoint.
- `src/components/`: React feature shells and browser study lifecycle. The study adapter owns mutable descendants so Migaku parsing survives React updates.
- `src/miner/`: study state, controllers, review/practice/queue/backup coordination.
- `src/domain/`, `src/worker/`: pure vocabulary logic and background parsing/querying.
- `src/server/`: validated operations, Drizzle schema, PostgreSQL transactions.
- `src/storage/remote-store.ts`: bounded, serialized cloud storage adapter.
- `src/storage/`: shared ports plus retained legacy/in-memory adapters for compatibility tests.
- `src/ui/`, `src/platform/`: study views, highlighting, file adapters, read-only Anki access.
- `migrations/`, `scripts/`: database migrations and staging cleanup.

The approved design and implementation record live in `docs/superpowers/`.
