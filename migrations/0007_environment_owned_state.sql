-- Environment-owned state now lives in each EnvironmentDO's SQLite.
-- This release deliberately starts a new Harness data layout; no legacy
-- settings, presets or workspace memberships are imported or dual-written.
-- The platform environment catalogue and its tenant ownership are retained.
DROP TABLE IF EXISTS environment_settings;
DROP TABLE IF EXISTS agent_revisions;
DROP TABLE IF EXISTS workspace_state;
DROP TABLE IF EXISTS workspaces;
