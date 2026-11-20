CREATE TYPE "public"."agent_kind" AS ENUM('agent', 'skill');--> statement-breakpoint
CREATE TYPE "public"."agent_source" AS ENUM('builtin', 'repo');--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_slug_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "source" "agent_source" DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "kind" "agent_kind" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "min_project_role" "project_role";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_builtin_slug_uq" ON "agents" USING btree ("slug") WHERE "agents"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_repo_slug_uq" ON "agents" USING btree ("project_id","branch","slug") WHERE "agents"."project_id" is not null;