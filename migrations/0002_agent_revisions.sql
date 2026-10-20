-- Agent compositions: every published revision of each Agent preset of an
-- environment, append-only. The newest revision of an id is its current spec.
CREATE TABLE agent_revisions (
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, agent_id, revision)
) STRICT;
