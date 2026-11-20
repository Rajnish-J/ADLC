ALTER TYPE "public"."repo_provider" ADD VALUE 'workspace';--> statement-breakpoint
ALTER TABLE "project_repositories" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_connection_id_git_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."git_connections"("id") ON DELETE set null ON UPDATE no action;