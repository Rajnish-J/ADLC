CREATE TABLE "git_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "repo_provider" NOT NULL,
	"owner" text,
	"name" text NOT NULL,
	"credential_enc" text NOT NULL,
	"credential_hint" text NOT NULL,
	"account" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_connections_scope_uq" ON "git_connections" USING btree ("org_id","provider",lower(coalesce("owner", '')));