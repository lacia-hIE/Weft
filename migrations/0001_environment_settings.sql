-- Environment settings documents: the user layer of each official settings
-- namespace, one row per environment and namespace. Secrets never enter this
-- table; credentials stay in the environment's Durable Object.
CREATE TABLE environment_settings (
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  ns TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, ns)
) STRICT;
