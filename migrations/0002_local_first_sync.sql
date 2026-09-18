CREATE TABLE sync_events (
  id bigserial PRIMARY KEY,
  app_revision bigint NOT NULL,
  resource text NOT NULL,
  resource_key text,
  action text NOT NULL,
  origin_device_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_events_created_order_idx ON sync_events(id);

CREATE TABLE sync_mutations (
  mutation_id uuid PRIMARY KEY,
  device_id text NOT NULL,
  accepted_event_id bigint REFERENCES sync_events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
