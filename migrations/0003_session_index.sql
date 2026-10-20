-- Discoverable root Sessions of each environment: title, Agent binding,
-- workspace and last activity. Session logs stay in each SessionDO.
CREATE TABLE session_index (
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, session_id)
) STRICT;
CREATE INDEX session_index_recent ON session_index (tenant_id, environment_id, updated_at DESC);
