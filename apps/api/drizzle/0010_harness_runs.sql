CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
ALTER TYPE "public"."run_origin" ADD VALUE 'web';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'requested' BEFORE 'queued';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'expired';--> statement-breakpoint
CREATE TABLE "run_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"node_id" text,
	"step_label" text,
	"evaluator" text NOT NULL,
	"score" double precision,
	"threshold" double precision,
	"pass" boolean NOT NULL,
	"required" boolean,
	"reason" text,
	"passed_count" integer,
	"failed_count" integer,
	"errored_count" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"source" text,
	"eval_id" text,
	"eval_run_id" text,
	"report_url" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"step_id" text,
	"agent_type" text,
	"agent_name" text,
	"skill" text,
	"tool" text,
	"path" text,
	"summary" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"assignee_id" uuid,
	"rank" double precision DEFAULT 0 NOT NULL,
	"external" jsonb,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "agent_slug" text;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "skills" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "skills_used" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "tool_calls" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workflow_version" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "engine_model" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "engine_session_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "run_evaluations" ADD CONSTRAINT "run_evaluations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_tasks" ADD CONSTRAINT "story_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_tasks" ADD CONSTRAINT "story_tasks_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_tasks" ADD CONSTRAINT "story_tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_tasks" ADD CONSTRAINT "story_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_evaluations_run_step_evaluator_uq" ON "run_evaluations" USING btree ("run_id","step_id","evaluator");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq_uq" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "story_tasks_story_number_uq" ON "story_tasks" USING btree ("story_id","number");--> statement-breakpoint
CREATE INDEX "story_tasks_project_idx" ON "story_tasks" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_story_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."story_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_project_status_idx" ON "runs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
-- Backfill: every evaluator score already stored on a gate step becomes a run_evaluations row.
INSERT INTO "run_evaluations" ("run_id", "step_id", "node_id", "step_label", "evaluator", "score", "threshold", "pass", "report_url", "created_at", "updated_at")
SELECT s."run_id", s."step_id", s."node_id", s."label", e->>'evaluator', (e->>'score')::double precision, (e->>'threshold')::double precision,
       COALESCE((e->>'pass')::boolean, false), s."report_url", COALESCE(s."finished_at", now()), now()
FROM "run_steps" s, jsonb_array_elements(s."evaluations") AS e
WHERE jsonb_typeof(s."evaluations") = 'array' AND e ? 'evaluator'
ON CONFLICT ("run_id", "step_id", "evaluator") DO NOTHING;
