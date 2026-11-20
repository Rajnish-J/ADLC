CREATE TYPE "public"."run_driver" AS ENUM('extension', 'orchestrator');--> statement-breakpoint
CREATE TYPE "public"."step_assignment_status" AS ENUM('pending', 'delivered', 'submitted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."step_phase" AS ENUM('plan', 'execute');--> statement-breakpoint
CREATE TABLE "step_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"node_id" text NOT NULL,
	"phase" "step_phase" NOT NULL,
	"harness" text NOT NULL,
	"payload" jsonb NOT NULL,
	"interrupt_id" text,
	"status" "step_assignment_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "driver" "run_driver" DEFAULT 'extension' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "spec_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "step_assignments" ADD CONSTRAINT "step_assignments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "step_assignments_run_step_phase_uq" ON "step_assignments" USING btree ("run_id","step_id","phase");--> statement-breakpoint
CREATE INDEX "step_assignments_run_status_idx" ON "step_assignments" USING btree ("run_id","status");--> statement-breakpoint
-- LangGraph checkpoint tables (created by the orchestrator service with AsyncPostgresSaver.setup()) live here, apart
-- from the Drizzle-managed public schema.
CREATE SCHEMA IF NOT EXISTS "orchestrator";