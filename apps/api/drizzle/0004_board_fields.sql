ALTER TABLE "stories" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "rank" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "stories_project_rank_idx" ON "stories" USING btree ("project_id","rank");--> statement-breakpoint
-- Existing stories keep the order the board showed before ranks existed: priority (the enum is declared
-- critical → low), then number, spaced 1024 apart so drops can land between them.
UPDATE "stories" s SET "rank" = r.rn * 1024
  FROM (SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "priority", "number") AS rn FROM "stories") r
  WHERE s."id" = r."id";
