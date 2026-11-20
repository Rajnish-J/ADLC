CREATE TABLE "run_changes" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"branch" text,
	"base_sha" text,
	"head_sha" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"patch" text,
	"patch_truncated" boolean DEFAULT false NOT NULL,
	"commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_feedback" (
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_feedback_run_id_user_id_pk" PRIMARY KEY("run_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "run_insights" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"impact_md" text,
	"failure_md" text,
	"model" text,
	"input_hash" text NOT NULL,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_memory_reads" (
	"run_id" uuid NOT NULL,
	"memory_item_id" uuid NOT NULL,
	"step_id" text,
	"via" text DEFAULT 'context' NOT NULL,
	"helpful" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_memory_reads_run_id_memory_item_id_pk" PRIMARY KEY("run_id","memory_item_id")
);
--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "run_changes" ADD CONSTRAINT "run_changes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_changes" ADD CONSTRAINT "run_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback" ADD CONSTRAINT "run_feedback_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback" ADD CONSTRAINT "run_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_insights" ADD CONSTRAINT "run_insights_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_insights" ADD CONSTRAINT "run_insights_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_memory_reads" ADD CONSTRAINT "run_memory_reads_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_memory_reads" ADD CONSTRAINT "run_memory_reads_memory_item_id_memory_items_id_fk" FOREIGN KEY ("memory_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_memory_reads_item_idx" ON "run_memory_reads" USING btree ("memory_item_id");--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_run_idx" ON "memory_items" USING btree ("run_id");--> statement-breakpoint
UPDATE "memory_items" m SET "run_id" = r."id" FROM "runs" r WHERE m."source" = 'run' AND m."run_id" IS NULL AND m."source_ref" LIKE 'run:%' AND r."id"::text = substring(m."source_ref" from 5 for 36);
