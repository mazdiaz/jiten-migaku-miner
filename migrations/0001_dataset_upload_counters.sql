ALTER TABLE datasets
  ADD COLUMN uploaded_rows bigint NOT NULL DEFAULT 0,
  ADD COLUMN uploaded_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN next_ordinal integer NOT NULL DEFAULT 0;
