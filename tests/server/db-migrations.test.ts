import { describe, expect, it } from "vitest";
import {
  migrationChecksum,
  migrationCompatibleChecksums,
  verifyMigrationLedger,
} from "../../src/server/db/migrations";

const expected = [
  { name: "0000_postgres_store.sql", checksum: "checksum-0000" },
  { name: "0001_dataset_upload_counters.sql", checksum: "checksum-0001" },
  { name: "0002_local_first_sync.sql", checksum: "checksum-0002" },
];

describe("database migration verification", () => {
  it("recognizes a complete ledger with matching checksums", () => {
    expect(verifyMigrationLedger(expected, expected)).toEqual({
      missing: [],
      checksumMismatches: [],
      unexpected: [],
    });
  });

  it("reports numbered migration files missing from the database ledger", () => {
    expect(verifyMigrationLedger(expected, expected.slice(0, 2))).toEqual({
      missing: ["0002_local_first_sync.sql"],
      checksumMismatches: [],
      unexpected: [],
    });
  });

  it("reports a changed checksum without treating it as missing", () => {
    expect(
      verifyMigrationLedger(expected, [
        expected[0]!,
        expected[1]!,
        { name: "0002_local_first_sync.sql", checksum: "stale-checksum" },
      ]),
    ).toEqual({
      missing: [],
      checksumMismatches: [
        {
          name: "0002_local_first_sync.sql",
          expected: "checksum-0002",
          actual: "stale-checksum",
        },
      ],
      unexpected: [],
    });
  });

  it("reports ledger entries with no numbered migration file", () => {
    expect(
      verifyMigrationLedger(expected, [
        ...expected,
        { name: "0003_removed.sql", checksum: "orphaned" },
      ]),
    ).toEqual({
      missing: [],
      checksumMismatches: [],
      unexpected: ["0003_removed.sql"],
    });
  });

  it("uses SHA-256 over migration source text", () => {
    expect(migrationChecksum("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
  it("accepts a legacy checksum that differs only by line endings", () => {
    const lf = "ALTER TABLE datasets\n  ADD COLUMN uploaded_rows bigint;\n";
    const crlf = lf.replaceAll("\n", "\r\n");
    const expectedMigration = {
      name: "0001_dataset_upload_counters.sql",
      checksum: migrationChecksum(lf),
      acceptedChecksums: migrationCompatibleChecksums(lf),
    };

    expect(
      verifyMigrationLedger(
        [expectedMigration],
        [{ name: expectedMigration.name, checksum: migrationChecksum(crlf) }],
      ),
    ).toEqual({
      missing: [],
      checksumMismatches: [],
      unexpected: [],
    });
  });

});
