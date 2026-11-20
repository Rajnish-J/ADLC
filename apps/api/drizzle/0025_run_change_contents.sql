CREATE TABLE "run_change_contents" (
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"old_path" text,
	"original" text,
	"modified" text,
	"truncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "run_change_contents_run_id_path_pk" PRIMARY KEY("run_id","path")
);
--> statement-breakpoint
ALTER TABLE "run_change_contents" ADD CONSTRAINT "run_change_contents_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;