CREATE TYPE "public"."message_author" AS ENUM('client', 'staff');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"file_id" uuid,
	"upload_session_id" uuid,
	"author_type" "message_author" NOT NULL,
	"author_user_id" uuid,
	"author_name" text,
	"author_email" text,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portals" ALTER COLUMN "allow_client_view_files" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "portals" ADD COLUMN "allow_client_messages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_upload_session_id_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_portal_idx" ON "messages" USING btree ("portal_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_file_idx" ON "messages" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "messages_client_idx" ON "messages" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "messages_unread_idx" ON "messages" USING btree ("author_type","read_at");--> statement-breakpoint
-- Client dashboards show the portal's files by default; enable it for existing portals too.
UPDATE "portals" SET "allow_client_view_files" = true;
