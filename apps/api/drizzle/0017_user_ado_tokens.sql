CREATE TABLE "user_ado_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"credential_enc" text NOT NULL,
	"credential_hint" text NOT NULL,
	"account" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_ado_tokens" ADD CONSTRAINT "user_ado_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;