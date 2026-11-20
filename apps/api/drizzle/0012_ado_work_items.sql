CREATE TABLE "project_boards" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"organization" text NOT NULL,
	"ado_project" text NOT NULL,
	"work_item_types" text[] NOT NULL,
	"last_synced_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_external_links" (
	"story_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"item_type" text NOT NULL,
	"state" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_external_identities" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"identity" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_external_identities_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "project_boards" ADD CONSTRAINT "project_boards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boards" ADD CONSTRAINT "project_boards_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_external_links" ADD CONSTRAINT "story_external_links_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_external_links" ADD CONSTRAINT "story_external_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_external_identities" ADD CONSTRAINT "user_external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "story_external_links_item_uq" ON "story_external_links" USING btree ("project_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "story_external_links_project_idx" ON "story_external_links" USING btree ("project_id");