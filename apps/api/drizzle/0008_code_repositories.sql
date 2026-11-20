CREATE TYPE "public"."repo_entry_type" AS ENUM('file', 'dir');--> statement-breakpoint
CREATE TYPE "public"."repo_file_status" AS ENUM('stored', 'binary', 'too_large', 'non_utf8', 'secret', 'submodule', 'symlink');--> statement-breakpoint
CREATE TYPE "public"."repo_provider" AS ENUM('github', 'azure-repos', 'local');--> statement-breakpoint
CREATE TYPE "public"."repo_status" AS ENUM('queued', 'syncing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."repo_sync_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."repo_sync_trigger" AS ENUM('link', 'manual', 'branch', 'commit', 'startup');--> statement-breakpoint
CREATE TABLE "project_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "repo_provider" NOT NULL,
	"remote_url" text NOT NULL,
	"web_url" text,
	"display_name" text NOT NULL,
	"default_branch" text,
	"default_branch_pinned" boolean DEFAULT false NOT NULL,
	"credential_enc" text,
	"credential_hint" text,
	"status" "repo_status" DEFAULT 'queued' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_repositories_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "repo_blobs" (
	"repository_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"size" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_blobs_repository_id_sha_pk" PRIMARY KEY("repository_id","sha")
);
--> statement-breakpoint
CREATE TABLE "repo_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"name" text NOT NULL,
	"remote_sha" text NOT NULL,
	"indexed_sha" text,
	"indexed_at" timestamp with time zone,
	"is_default" boolean DEFAULT false NOT NULL,
	"commit_message" text,
	"commit_author" text,
	"committed_at" timestamp with time zone,
	"file_count" integer DEFAULT 0 NOT NULL,
	"ignored_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_file_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"path" text NOT NULL,
	"user_id" uuid NOT NULL,
	"base_blob_sha" text NOT NULL,
	"content" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_files" (
	"branch_id" uuid NOT NULL,
	"path" text NOT NULL,
	"dir" text NOT NULL,
	"name" text NOT NULL,
	"type" "repo_entry_type" NOT NULL,
	"mode" text NOT NULL,
	"blob_sha" text,
	"size" integer DEFAULT 0 NOT NULL,
	"status" "repo_file_status",
	CONSTRAINT "repo_files_branch_id_path_pk" PRIMARY KEY("branch_id","path")
);
--> statement-breakpoint
CREATE TABLE "repo_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"trigger" "repo_sync_trigger" NOT NULL,
	"branch" text,
	"status" "repo_sync_status" DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_blobs" ADD CONSTRAINT "repo_blobs_repository_id_project_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."project_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_branches" ADD CONSTRAINT "repo_branches_repository_id_project_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."project_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_file_drafts" ADD CONSTRAINT "repo_file_drafts_repository_id_project_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."project_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_file_drafts" ADD CONSTRAINT "repo_file_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_files" ADD CONSTRAINT "repo_files_branch_id_repo_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."repo_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_syncs" ADD CONSTRAINT "repo_syncs_repository_id_project_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."project_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_syncs" ADD CONSTRAINT "repo_syncs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_branches_repo_name_uq" ON "repo_branches" USING btree ("repository_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_file_drafts_uq" ON "repo_file_drafts" USING btree ("repository_id","branch","path","user_id");--> statement-breakpoint
CREATE INDEX "repo_files_branch_dir_idx" ON "repo_files" USING btree ("branch_id","dir");--> statement-breakpoint
CREATE INDEX "repo_syncs_repo_created_idx" ON "repo_syncs" USING btree ("repository_id","created_at");