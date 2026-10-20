-- Harness environments of each tenant. Each environment's own configuration
-- lives in the tables above, keyed by (tenant_id, environment_id).
CREATE TABLE environments (
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (tenant_id, environment_id)
) STRICT;
