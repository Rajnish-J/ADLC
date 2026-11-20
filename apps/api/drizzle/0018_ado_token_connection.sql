ALTER TABLE "user_ado_tokens" ALTER COLUMN "credential_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_ado_tokens" ALTER COLUMN "credential_hint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_ado_tokens" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "user_ado_tokens" ADD CONSTRAINT "user_ado_tokens_connection_id_git_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."git_connections"("id") ON DELETE cascade ON UPDATE no action;