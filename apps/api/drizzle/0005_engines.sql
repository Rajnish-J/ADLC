CREATE TABLE "client_presence" (
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"engines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspace" jsonb,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_presence_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"agent_engine" text,
	"engine_model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "client_presence" ADD CONSTRAINT "client_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;