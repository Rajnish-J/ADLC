-- Clear the platform agent catalog. The default set seeded from .claude/agents is being redesigned; the right
-- agents will be configured afterwards. Removing an agent also removes its per-project settings (project_agents
-- cascades). Workflows reference agents only inside their jsonb spec, so nothing else depends on these rows.
DELETE FROM agents;
