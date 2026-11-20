ALTER TABLE "run_steps" ADD COLUMN "evaluations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "report_url" text;