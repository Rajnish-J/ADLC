CREATE TYPE "public"."profile_status" AS ENUM('generating', 'proposed', 'accepted', 'rejected', 'superseded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."profile_trigger" AS ENUM('manual', 'run');--> statement-breakpoint
CREATE TABLE "project_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "profile_status" DEFAULT 'generating' NOT NULL,
	"trigger" "profile_trigger" DEFAULT 'manual' NOT NULL,
	"branch" text,
	"commit_sha" text,
	"content" jsonb,
	"markdown" text DEFAULT '' NOT NULL,
	"ai_written" boolean DEFAULT true NOT NULL,
	"input_hash" text,
	"model" text,
	"error" text,
	"run_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"based_on_id" uuid,
	"created_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_profiles_version_uq" ON "project_profiles" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_profiles_accepted_uq" ON "project_profiles" USING btree ("project_id") WHERE "project_profiles"."status" = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "project_profiles_open_uq" ON "project_profiles" USING btree ("project_id") WHERE "project_profiles"."status" in ('generating', 'proposed');--> statement-breakpoint
CREATE INDEX "project_profiles_project_idx" ON "project_profiles" USING btree ("project_id","created_at");