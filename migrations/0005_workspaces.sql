-- Workspace registry of each environment: the order, pins and archive state,
-- and one row per Workspace. Workspace files stay in each WorkspaceDO volume.
CREATE TABLE workspace_state (
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (tenant_id, environment_id)
) STRICT;
CREATE TABLE workspaces (
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, workspace_id),
  UNIQUE (tenant_id, environment_id, path)
) STRICT;
