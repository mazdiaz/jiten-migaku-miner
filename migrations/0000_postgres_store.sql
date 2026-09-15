CREATE TABLE datasets (
 id text PRIMARY KEY, upload_id uuid NOT NULL UNIQUE, metadata jsonb NOT NULL,
 status text NOT NULL DEFAULT 'staging' CHECK(status IN ('staging','ready')),
 base_revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dataset_chunks (
 dataset_id text NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal >= 0), entries jsonb NOT NULL,
 row_count integer NOT NULL CHECK(row_count > 0), byte_count integer NOT NULL CHECK(byte_count <= 400000),
 PRIMARY KEY(dataset_id, ordinal)
);
CREATE TABLE app_state (
 id integer PRIMARY KEY CHECK(id = 1), revision bigint NOT NULL DEFAULT 0,
 active_dataset_id text REFERENCES datasets(id) ON DELETE SET NULL,
 known_metadata jsonb, preferences jsonb, anki_config jsonb, anki_synced_at text
);
CREATE TABLE known_words (word text PRIMARY KEY);
CREATE TABLE word_decisions (word text PRIMARY KEY, decision jsonb NOT NULL);
CREATE TABLE anki_statuses (word text PRIMARY KEY, status text NOT NULL CHECK(status IN ('known','mined')));
CREATE TABLE queues (dataset_id text PRIMARY KEY REFERENCES datasets(id) ON DELETE CASCADE);
CREATE TABLE queue_words (
 dataset_id text NOT NULL REFERENCES queues(dataset_id) ON DELETE CASCADE, word text NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal >= 0), PRIMARY KEY(dataset_id, word), UNIQUE(dataset_id, ordinal)
);
CREATE TABLE state_uploads (
 id uuid PRIMARY KEY, target text NOT NULL, base_revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE state_upload_chunks (
 upload_id uuid NOT NULL REFERENCES state_uploads(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal >= 0), payload text NOT NULL, byte_count integer NOT NULL,
 PRIMARY KEY(upload_id, ordinal)
);
