"""SQLAlchemy Core mirrors of the platform tables this service reads and writes.

Drizzle (apps/api/src/db/schema.ts) owns the schema and every migration; these are hand-kept mirrors of the columns
used here. `tests/test_schema_parity.py` reflects the dev database and fails when a mirrored column is missing.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

metadata = sa.MetaData()


def _enum(name: str, *values: str) -> pg.ENUM:
    # create_type=False: the types are created by Drizzle migrations, never by this service.
    return pg.ENUM(*values, name=name, create_type=False)


UUID = pg.UUID(as_uuid=False)
TS = sa.DateTime(timezone=True)
TEXT_ARRAY = pg.ARRAY(sa.Text)

ORG_ROLE = _enum("org_role", "org_admin", "member")
PROJECT_ROLE = _enum("project_role", "owner", "lead", "developer", "viewer")
AGENT_SOURCE = _enum("agent_source", "builtin", "repo", "platform")
AGENT_KIND = _enum("agent_kind", "agent", "skill")
EXECUTION_TARGET = _enum("execution_target", "local", "server")
RUN_STATUS = _enum(
    "run_status", "requested", "queued", "running", "awaiting_approval", "completed", "failed", "cancelled", "expired"
)
RUN_STEP_STATUS = _enum("run_step_status", "running", "succeeded", "failed", "skipped", "blocked")
RUN_ORIGIN = _enum("run_origin", "extension", "server", "web")
RUN_DRIVER = _enum("run_driver", "extension", "orchestrator")
STEP_PHASE = _enum("step_phase", "plan", "execute")
STEP_ASSIGNMENT_STATUS = _enum("step_assignment_status", "pending", "delivered", "submitted", "cancelled")

users = sa.Table(
    "users",
    metadata,
    sa.Column("id", UUID, primary_key=True),
    sa.Column("org_id", UUID, nullable=False),
    sa.Column("email", sa.Text, nullable=False),
    sa.Column("display_name", sa.Text, nullable=False),
    sa.Column("org_role", ORG_ROLE, nullable=False),
)

projects = sa.Table(
    "projects",
    metadata,
    sa.Column("id", UUID, primary_key=True),
    sa.Column("org_id", UUID, nullable=False),
    sa.Column("key", sa.Text, nullable=False),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("settings", pg.JSONB, nullable=False),
    sa.Column("archived_at", TS),
)

project_members = sa.Table(
    "project_members",
    metadata,
    sa.Column("project_id", UUID, primary_key=True),
    sa.Column("user_id", UUID, primary_key=True),
    sa.Column("role", PROJECT_ROLE, nullable=False),
)

stories = sa.Table(
    "stories",
    metadata,
    sa.Column("id", UUID, primary_key=True),
    sa.Column("project_id", UUID, nullable=False),
    sa.Column("number", sa.Integer, nullable=False),
    sa.Column("title", sa.Text, nullable=False),
    sa.Column("description", sa.Text, nullable=False),
    sa.Column("acceptance_criteria", pg.JSONB, nullable=False),
    sa.Column("assignee_id", UUID),
    sa.Column("status", sa.Text, nullable=False),
    sa.Column("is_blocked", sa.Boolean, nullable=False),
)

story_tasks = sa.Table(
    "story_tasks",
    metadata,
    sa.Column("id", UUID, primary_key=True),
    sa.Column("project_id", UUID, nullable=False),
    sa.Column("story_id", UUID, nullable=False),
    sa.Column("number", sa.Integer, nullable=False),
    sa.Column("title", sa.Text, nullable=False),
    sa.Column("description", sa.Text, nullable=False),
    sa.Column("status", sa.Text, nullable=False),
    sa.Column("assignee_id", UUID),
    sa.Column("rank", sa.Float, nullable=False),
    sa.Column("external", pg.JSONB),
    sa.Column("created_by", UUID, nullable=False),
    sa.Column("version", sa.Integer, nullable=False),
    sa.Column("created_at", TS, nullable=False),
    sa.Column("updated_at", TS, nullable=False),
)

agents = sa.Table(
    "agents",
    metadata,
    sa.Column("id", UUID, primary_key=True, server_default=sa.text("gen_random_uuid()")),
    sa.Column("slug", sa.Text, nullable=False),
    sa.Column("source", AGENT_SOURCE, nullable=False),
    sa.Column("kind", AGENT_KIND, nullable=False),
    sa.Column("project_id", UUID),
    sa.Column("branch", sa.Text),
    sa.Column("content_hash", sa.Text),
    sa.Column("min_project_role", PROJECT_ROLE),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("description", sa.Text, nullable=False),
    sa.Column("category", sa.Text, nullable=False),
    sa.Column("sdlc_stage", sa.Text, nullable=False),
    sa.Column("execution_target", EXECUTION_TARGET, nullable=False),
    sa.Column("tools", TEXT_ARRAY, nullable=False),
    sa.Column("instructions", sa.Text, nullable=False),
    sa.Column("source_path", sa.Text),
    sa.Column("model", sa.Text),
    sa.Column("issues", pg.JSONB, nullable=False),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
)

project_agents = sa.Table(
    "project_agents",
    metadata,
    sa.Column("project_id", UUID, primary_key=True),
    sa.Column("agent_id", UUID, primary_key=True),
    sa.Column("enabled", sa.Boolean, nullable=False),
    sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
)

workflows = sa.Table(
    "workflows",
    metadata,
    sa.Column("id", UUID, primary_key=True, server_default=sa.text("gen_random_uuid()")),
    sa.Column("project_id", UUID),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("description", sa.Text, nullable=False),
    sa.Column("is_default", sa.Boolean, nullable=False),
    sa.Column("spec", pg.JSONB, nullable=False),
    sa.Column("version", sa.Integer, nullable=False),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
)

audit_log = sa.Table(
    "audit_log",
    metadata,
    sa.Column("id", sa.BigInteger, primary_key=True),
    sa.Column("org_id", UUID, nullable=False),
    sa.Column("project_id", UUID),
    sa.Column("actor_user_id", UUID),
    sa.Column("action", sa.Text, nullable=False),
    sa.Column("resource_type", sa.Text, nullable=False),
    sa.Column("resource_id", sa.Text, nullable=False),
    sa.Column("data", pg.JSONB, nullable=False),
    sa.Column("via", sa.Text, nullable=False),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
)

runs = sa.Table(
    "runs",
    metadata,
    sa.Column("id", UUID, primary_key=True, server_default=sa.text("gen_random_uuid()")),
    sa.Column("org_id", UUID, nullable=False),
    sa.Column("project_id", UUID, nullable=False),
    sa.Column("story_id", UUID),
    sa.Column("user_id", UUID),
    sa.Column("origin", RUN_ORIGIN, nullable=False),
    sa.Column("driver", RUN_DRIVER, nullable=False),
    sa.Column("spec_snapshot", pg.JSONB),
    sa.Column("client_run_id", sa.Text, nullable=False),
    sa.Column("workflow_name", sa.Text, nullable=False),
    sa.Column("status", RUN_STATUS, nullable=False),
    sa.Column("started_at", TS, nullable=False),
    sa.Column("finished_at", TS),
    sa.Column("error", sa.Text),
    sa.Column("pending_approval", pg.JSONB),
    sa.Column("tokens_in", sa.Integer, nullable=False),
    sa.Column("tokens_out", sa.Integer, nullable=False),
    sa.Column("changed_files", TEXT_ARRAY, nullable=False),
    sa.Column("task_id", UUID),
    sa.Column("workflow_id", UUID),
    sa.Column("workflow_version", sa.Integer),
    sa.Column("engine", sa.Text),
    sa.Column("engine_model", sa.Text),
    sa.Column("engine_session_id", sa.Text),
    # A quick fix started from a prompt (no story), or extra instructions given with the story.
    sa.Column("prompt", sa.Text),
    sa.Column("requested_by", UUID),
    sa.Column("requested_at", TS),
    sa.Column("claimed_at", TS),
    sa.Column("client_id", sa.Text),
    # When the gateway confirmed it captured the ended run; the sweeper re-notifies until it is set.
    sa.Column("finish_notified_at", TS),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
)

run_steps = sa.Table(
    "run_steps",
    metadata,
    sa.Column("id", UUID, primary_key=True, server_default=sa.text("gen_random_uuid()")),
    sa.Column("run_id", UUID, nullable=False),
    sa.Column("step_id", sa.Text, nullable=False),
    sa.Column("seq", sa.Integer, nullable=False),
    sa.Column("node_id", sa.Text, nullable=False),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("label", sa.Text, nullable=False),
    sa.Column("status", RUN_STEP_STATUS, nullable=False),
    sa.Column("started_at", TS),
    sa.Column("finished_at", TS),
    sa.Column("tokens_in", sa.Integer),
    sa.Column("tokens_out", sa.Integer),
    sa.Column("gate_pass", sa.Boolean),
    sa.Column("gate_reason", sa.Text),
    sa.Column("approval", pg.JSONB),
    sa.Column("output", sa.Text),
    sa.Column("plan", sa.Text),
    sa.Column("error", sa.Text),
    sa.Column("changed_files", TEXT_ARRAY, nullable=False),
    sa.Column("evaluations", pg.JSONB, nullable=False),
    sa.Column("report_url", sa.Text),
    sa.Column("agent_slug", sa.Text),
    sa.Column("agent_name", sa.Text),
    sa.Column("skills", TEXT_ARRAY, nullable=False),
    sa.Column("skills_used", pg.JSONB, nullable=False),
    sa.Column("model", sa.Text),
    sa.Column("tool_calls", sa.Integer),
    sa.Column("engine", sa.Text),
)

run_events = sa.Table(
    "run_events",
    metadata,
    sa.Column("id", sa.BigInteger, primary_key=True),
    sa.Column("run_id", UUID, nullable=False),
    sa.Column("seq", sa.Integer, nullable=False),
    sa.Column("at", TS, nullable=False),
    sa.Column("type", sa.Text, nullable=False),
    sa.Column("step_id", sa.Text),
    sa.Column("agent_type", sa.Text),
    sa.Column("agent_name", sa.Text),
    sa.Column("skill", sa.Text),
    sa.Column("tool", sa.Text),
    sa.Column("path", sa.Text),
    sa.Column("summary", sa.Text),
    sa.Column("data", pg.JSONB, nullable=False),
)

run_evaluations = sa.Table(
    "run_evaluations",
    metadata,
    sa.Column("id", UUID, primary_key=True, server_default=sa.text("gen_random_uuid()")),
    sa.Column("run_id", UUID, nullable=False),
    sa.Column("step_id", sa.Text, nullable=False),
    sa.Column("node_id", sa.Text),
    sa.Column("step_label", sa.Text),
    sa.Column("evaluator", sa.Text, nullable=False),
    sa.Column("score", sa.Float),
    sa.Column("threshold", sa.Float),
    sa.Column("pass", sa.Boolean, nullable=False),
    sa.Column("required", sa.Boolean),
    sa.Column("reason", sa.Text),
    sa.Column("passed_count", sa.Integer),
    sa.Column("failed_count", sa.Integer),
    sa.Column("errored_count", sa.Integer),
    sa.Column("tokens_in", sa.Integer),
    sa.Column("tokens_out", sa.Integer),
    sa.Column("source", sa.Text),
    sa.Column("eval_id", sa.Text),
    sa.Column("eval_run_id", sa.Text),
    sa.Column("report_url", sa.Text),
    sa.Column("details", pg.JSONB),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
)

# VS Code's exact report of a run's changes (the gateway writes it). The runner only checks that one exists, so it
# leaves runs.changed_files to that exact list instead of re-adding files from the steps.
run_changes = sa.Table(
    "run_changes",
    metadata,
    sa.Column("run_id", UUID, primary_key=True),
    sa.Column("updated_at", TS, nullable=False),
)

step_assignments = sa.Table(
    "step_assignments",
    metadata,
    sa.Column("id", UUID, primary_key=True, server_default=sa.text("gen_random_uuid()")),
    sa.Column("run_id", UUID, nullable=False),
    sa.Column("step_id", sa.Text, nullable=False),
    sa.Column("node_id", sa.Text, nullable=False),
    sa.Column("phase", STEP_PHASE, nullable=False),
    sa.Column("harness", sa.Text, nullable=False),
    sa.Column("payload", pg.JSONB, nullable=False),
    sa.Column("interrupt_id", sa.Text),
    sa.Column("status", STEP_ASSIGNMENT_STATUS, nullable=False),
    sa.Column("result", pg.JSONB),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    sa.Column("delivered_at", TS),
    sa.Column("submitted_at", TS),
)

client_presence = sa.Table(
    "client_presence",
    metadata,
    sa.Column("user_id", UUID, primary_key=True),
    sa.Column("client_id", sa.Text, primary_key=True),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("version", sa.Text, nullable=False),
    sa.Column("engines", pg.JSONB, nullable=False),
    sa.Column("workspace", pg.JSONB),
    sa.Column("last_seen_at", TS, nullable=False),
)

user_preferences = sa.Table(
    "user_preferences",
    metadata,
    sa.Column("user_id", UUID, primary_key=True),
    sa.Column("agent_engine", sa.Text),
    sa.Column("engine_model", sa.Text),
)
