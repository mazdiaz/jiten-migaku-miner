import postgres from "postgres";
import { loadMigrations } from "../src/server/db/migrations";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running migrations.");
const connection = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const migrations = await loadMigrations();
  await connection.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(873466220)`;
    await tx`CREATE TABLE IF NOT EXISTS miner_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const migration of migrations) {
      const previous = await tx`SELECT checksum FROM miner_migrations WHERE name = ${migration.name}`;
      if (previous.length) {
        const previousChecksum = previous[0]?.checksum;
        if (
          previousChecksum !== migration.checksum &&
          !migration.acceptedChecksums.includes(previousChecksum ?? "")
        )
          throw new Error(
            `Previously applied migration changed: ${migration.name}. Restore it and add a new migration.`,
          );
        continue;
      }
      await tx.unsafe(migration.source);
      await tx`INSERT INTO miner_migrations(name, checksum) VALUES (${migration.name}, ${migration.checksum})`;
      console.log(`Applied ${migration.name}`);
    }
  });
  console.log("Database schema is current.");
} finally {
  await connection.end();
}
