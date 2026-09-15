import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running migrations.");
const connection = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  await connection.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(873466220)`;
    await tx`CREATE TABLE IF NOT EXISTS miner_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const source = await readFile(new URL(name, directory), "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const previous = await tx`SELECT checksum FROM miner_migrations WHERE name = ${name}`;
      if (previous.length) {
        if (previous[0]?.checksum !== checksum) throw new Error(`Previously applied migration changed: ${name}. Restore it and add a new migration.`);
        continue;
      }
      await tx.unsafe(source);
      await tx`INSERT INTO miner_migrations(name, checksum) VALUES (${name}, ${checksum})`;
      console.log(`Applied ${name}`);
    }
  });
  console.log("Database schema is current.");
} finally { await connection.end(); }
