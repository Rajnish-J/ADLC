ALTER TYPE "public"."agent_source" ADD VALUE 'platform';--> statement-breakpoint
CREATE TABLE "chat_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"project_id" uuid,
	"target_id" text,
	"target_label" text,
	"data" jsonb NOT NULL,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"result" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"thread_id" uuid NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_thread_id_id_pk" PRIMARY KEY("thread_id","id")
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"agent" text DEFAULT 'default' NOT NULL,
	"project_id" uuid,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chat_drafts" ADD CONSTRAINT "chat_drafts_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_drafts" ADD CONSTRAINT "chat_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_drafts_thread_idx" ON "chat_drafts" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_drafts_open_idx" ON "chat_drafts" USING btree ("thread_id","kind") WHERE "chat_drafts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "chat_messages_thread_seq_idx" ON "chat_messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "chat_threads_user_idx" ON "chat_threads" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_platform_slug_uq" ON "agents" USING btree ("project_id","slug") WHERE "agents"."project_id" is not null and "agents"."branch" is null;