-- Smart API Gateway schema (idempotent: safe to run on every start)
-- PostgreSQL stores the request logs. API keys come from configuration (API_KEYS env var).

-- cleanup of tables from earlier versions (background jobs + key management were removed)
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS api_keys;

CREATE TABLE IF NOT EXISTS request_logs (
  id            BIGSERIAL PRIMARY KEY,
  request_id    TEXT        NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  method        TEXT        NOT NULL,
  path          TEXT        NOT NULL,
  status        INT         NOT NULL,
  latency_ms    INT         NOT NULL,
  service       TEXT,
  upstream      TEXT,
  client_id     TEXT,                              -- API client name (from config), NULL = anonymous
  client_ip     TEXT,
  cache_status  TEXT,
  rate_limited  BOOLEAN     NOT NULL DEFAULT FALSE,
  error         TEXT,
  gateway_id    TEXT
);

-- upgrade path from the earlier schema, where this column was api_key_id UUID
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'request_logs' AND column_name = 'api_key_id') THEN
    ALTER TABLE request_logs RENAME COLUMN api_key_id TO client_id;
    ALTER TABLE request_logs ALTER COLUMN client_id TYPE TEXT;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_request_logs_key_ts;
CREATE INDEX IF NOT EXISTS idx_request_logs_ts        ON request_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_client_ts ON request_logs (client_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_service   ON request_logs (service, ts DESC);
