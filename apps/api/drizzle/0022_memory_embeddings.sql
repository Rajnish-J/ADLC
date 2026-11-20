CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "memory_context_cache" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"markdown" text NOT NULL,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"memory_item_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_context_cache" ADD CONSTRAINT "memory_context_cache_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_item_id_memory_items_id_fk" FOREIGN KEY ("memory_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_context_cache_created_idx" ON "memory_context_cache" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "memory_embeddings_project_idx" ON "memory_embeddings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "memory_embeddings_hnsw" ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);
