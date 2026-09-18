import postgres from "postgres";
import {
  loadMigrations,
  type AppliedMigration,
  verifyMigrationLedger,
} from "../src/server/db/migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL before verifying the database schema.");

const connection = postgres(databaseUrl, { max: 1, prepare: false });

function isMissingMigrationLedger(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42P01";
}

try {
  const expected = await loadMigrations();
  let applied: AppliedMigration[];
  try {
    applied = await connection<AppliedMigration[]>`
      SELECT name, checksum
      FROM miner_migrations
      ORDER BY name
    `;
  } catch (error) {
    if (isMissingMigrationLedger(error)) {
      throw new Error("Migration ledger is missing. Run: npm run db:migrate");
    }
    throw new Error("Migration ledger could not be read. Check DATABASE_URL and database access.");
  }

  const verification = verifyMigrationLedger(expected, applied);
  if (
    verification.missing.length > 0 ||
    verification.checksumMismatches.length > 0 ||
    verification.unexpected.length > 0
  ) {
    if (verification.missing.length > 0) {
      console.error("Database schema is behind.");
      console.error("Missing migrations:");
      for (const name of verification.missing) console.error(`- ${name}`);
    }
    if (verification.checksumMismatches.length > 0) {
      console.error("Database schema is inconsistent.");
      console.error("Checksum mismatches:");
      for (const mismatch of verification.checksumMismatches) {
        console.error(`- ${mismatch.name} (expected ${mismatch.expected}, found ${mismatch.actual})`);
      }
    }
    if (verification.unexpected.length > 0) {
      console.error("Unexpected migrations in database ledger:");
      for (const name of verification.unexpected) console.error(`- ${name}`);
    }
    if (verification.checksumMismatches.length > 0 || verification.unexpected.length > 0) {
      console.error("Resolve migration ledger inconsistencies before running migrations.");
    } else {
      console.error("Run:");
      console.error("npm run db:migrate");
    }
    process.exitCode = 1;
  } else {
    console.log("Database schema is current.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database schema verification failed.");
  process.exitCode = 1;
} finally {
  await connection.end();
}
