DROP INDEX "git_connections_scope_uq";--> statement-breakpoint
CREATE INDEX "git_connections_scope_idx" ON "git_connections" USING btree ("org_id","provider",lower(coalesce("owner", '')));