import postgres from "postgres";
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before cleaning staging data.");
const connection = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  await connection.begin(async tx => {
    await tx`SELECT id FROM app_state WHERE id = 1 FOR UPDATE`;
    const uploads = await tx`DELETE FROM state_uploads WHERE created_at < now() - interval '24 hours' RETURNING id`;
    const datasets = await tx`DELETE FROM datasets WHERE status = 'staging' AND created_at < now() - interval '24 hours' RETURNING id`;
    console.log(`Removed ${uploads.length} abandoned state uploads and ${datasets.length} staged datasets. Saved datasets were retained.`);
  });
} finally { await connection.end(); }
