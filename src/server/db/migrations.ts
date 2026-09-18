import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const MIGRATION_FILE_PATTERN = /^\d+.*\.sql$/;

export interface MigrationFile {
  name: string;
  source: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
}

export interface MigrationVerification {
  missing: string[];
  checksumMismatches: Array<{
    name: string;
    expected: string;
    actual: string;
  }>;
  unexpected: string[];
}

export function migrationChecksum(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export async function loadMigrations(
  directory: URL = new URL("../../../migrations/", import.meta.url),
): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const source = await readFile(new URL(name, directory), "utf8");
      return { name, source, checksum: migrationChecksum(source) };
    }),
  );
}

export function verifyMigrationLedger(
  expected: readonly Pick<MigrationFile, "name" | "checksum">[],
  applied: readonly AppliedMigration[],
): MigrationVerification {
  const appliedByName = new Map(applied.map((migration) => [migration.name, migration.checksum]));
  const expectedByName = new Map(expected.map((migration) => [migration.name, migration.checksum]));
  const missing: string[] = [];
  const checksumMismatches: MigrationVerification["checksumMismatches"] = [];

  for (const migration of expected) {
    const actual = appliedByName.get(migration.name);
    if (actual === undefined) {
      missing.push(migration.name);
    } else if (actual !== migration.checksum) {
      checksumMismatches.push({
        name: migration.name,
        expected: migration.checksum,
        actual,
      });
    }
  }

  const unexpected = applied
    .map((migration) => migration.name)
    .filter((name) => !expectedByName.has(name))
    .sort();

  return { missing, checksumMismatches, unexpected };
}
