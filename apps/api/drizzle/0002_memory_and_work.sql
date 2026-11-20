CREATE TYPE "public"."memory_kind" AS ENUM('note', 'decision', 'convention', 'learning', 'summary');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('story', 'project');--> statement-breakpoint
CREATE TYPE "public"."memory_source" AS ENUM('manual', 'run', 'story_done', 'promotion');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('proposed', 'accepted', 'rejected', 'archived');--> statement-breakpoint
CREATE TYPE "public"."run_origin" AS ENUM('extension', 'server');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_step_status" AS ENUM('running', 'succeeded', 'failed', 'skipped', 'blocked');--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"story_id" uuid,
	"kind" "memory_kind" DEFAULT 'note' NOT NULL,
	"status" "memory_status" DEFAULT 'accepted' NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"file_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" "memory_source" DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"promoted_from_id" uuid,
	"created_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"seq" integer NOT NULL,
	"node_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"status" "run_step_status" NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"tokens_in" integer,
	"tokens_out" integer,
	"gate_pass" boolean,
	"gate_reason" text,
	"approval" jsonb,
	"output" text,
	"plan" text,
	"error" text,
	"changed_files" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"story_id" uuid,
	"user_id" uuid,
	"origin" "run_origin" DEFAULT 'extension' NOT NULL,
	"client_run_id" text NOT NULL,
	"workflow_name" text NOT NULL,
	"status" "run_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"pending_approval" jsonb,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"changed_files" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"branch" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"author_name" text DEFAULT '' NOT NULL,
	"author_email" text DEFAULT '' NOT NULL,
	"reported_by" uuid,
	"committed_at" timestamp with time zone NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"patch" text,
	"patch_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_workspaces" (
	"project_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"head_sha" text,
	"ahead" integer DEFAULT 0 NOT NULL,
	"behind" integer DEFAULT 0 NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"patch" text,
	"patch_truncated" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_workspaces_story_id_user_id_pk" PRIMARY KEY("story_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_promoted_from_id_memory_items_id_fk" FOREIGN KEY ("promoted_from_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_commits" ADD CONSTRAINT "story_commits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_commits" ADD CONSTRAINT "story_commits_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_commits" ADD CONSTRAINT "story_commits_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_workspaces" ADD CONSTRAINT "story_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_workspaces" ADD CONSTRAINT "story_workspaces_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_workspaces" ADD CONSTRAINT "story_workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_project_scope_status_idx" ON "memory_items" USING btree ("project_id","scope","status");--> statement-breakpoint
CREATE INDEX "memory_story_idx" ON "memory_items" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "memory_search_idx" ON "memory_items" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_source_ref_uq" ON "memory_items" USING btree ("project_id","source","source_ref") WHERE "memory_items"."source_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_step_uq" ON "run_steps" USING btree ("run_id","step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_user_client_run_uq" ON "runs" USING btree ("user_id","client_run_id");--> statement-breakpoint
CREATE INDEX "runs_story_idx" ON "runs" USING btree ("story_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "story_commits_story_sha_uq" ON "story_commits" USING btree ("story_id","sha");--> statement-breakpoint
CREATE INDEX "story_commits_story_idx" ON "story_commits" USING btree ("story_id","committed_at");