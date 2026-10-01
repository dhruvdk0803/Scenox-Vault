CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'client', 'system');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('queued', 'processing', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('uploading', 'processing', 'ready', 'quarantined', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."portal_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."activity_result" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'scanning', 'clean', 'infected', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."upload_session_status" AS ENUM('active', 'completed', 'abandoned', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"client_id" uuid,
	"portal_id" uuid,
	"ip" "inet",
	"user_agent" text,
	"request_id" text,
	"result" "activity_result" DEFAULT 'success' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"email" text,
	"phone" text,
	"notes" text,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"quota_bytes" bigint,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"upload_count" integer DEFAULT 0 NOT NULL,
	"last_upload_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"status" "export_status" DEFAULT 'queued' NOT NULL,
	"file_ids" uuid[] NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"output_key" text,
	"output_size" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"portal_id" uuid NOT NULL,
	"upload_session_id" uuid NOT NULL,
	"tus_id" text,
	"original_filename" text NOT NULL,
	"stored_filename" text NOT NULL,
	"relative_path" text DEFAULT '' NOT NULL,
	"extension" text DEFAULT '' NOT NULL,
	"mime_type" text,
	"detected_mime" text,
	"size" bigint NOT NULL,
	"bytes_received" bigint DEFAULT 0 NOT NULL,
	"checksum_sha256" text,
	"status" "file_status" DEFAULT 'uploading' NOT NULL,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"scan_result" text,
	"duplicate_of_id" uuid,
	"storage_key" text,
	"client_key" text,
	"last_modified" timestamp with time zone,
	"avg_speed_bps" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"recipient" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"client_id" uuid,
	"upload_session_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "portal_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"token_preview" text NOT NULL,
	"status" "portal_status" DEFAULT 'active' NOT NULL,
	"title" text,
	"description" text,
	"instructions" text,
	"logo_key" text,
	"expires_at" timestamp with time zone,
	"password_hash" text,
	"max_file_size_bytes" bigint,
	"max_total_bytes" bigint,
	"allowed_extensions" text[],
	"require_name" boolean DEFAULT false NOT NULL,
	"require_email" boolean DEFAULT false NOT NULL,
	"require_company" boolean DEFAULT false NOT NULL,
	"require_message" boolean DEFAULT false NOT NULL,
	"allow_multiple_sessions" boolean DEFAULT true NOT NULL,
	"allow_folders" boolean DEFAULT true NOT NULL,
	"allow_zip" boolean DEFAULT true NOT NULL,
	"allow_resume" boolean DEFAULT true NOT NULL,
	"allow_client_view_files" boolean DEFAULT false NOT NULL,
	"allow_client_delete_files" boolean DEFAULT false NOT NULL,
	"notify_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"notify_client" boolean DEFAULT false NOT NULL,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"last_upload_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "upload_session_status" DEFAULT 'active' NOT NULL,
	"uploader_name" text,
	"uploader_email" text,
	"uploader_company" text,
	"message" text,
	"ip" "inet",
	"user_agent" text,
	"total_files" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"uploaded_files" integer DEFAULT 0 NOT NULL,
	"uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"failed_files" integer DEFAULT 0 NOT NULL,
	"avg_speed_bps" bigint,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_upload_session_id_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_tokens" ADD CONSTRAINT "portal_access_tokens_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portals" ADD CONSTRAINT "portals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portals" ADD CONSTRAINT "portals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_client_idx" ON "activity_logs" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_action_idx" ON "activity_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "activity_actor_idx" ON "activity_logs" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "clients_status_idx" ON "clients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clients_created_idx" ON "clients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "clients_name_trgm_idx" ON "clients" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "export_jobs_user_idx" ON "export_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "export_jobs_status_idx" ON "export_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "files_tus_id_uq" ON "files" USING btree ("tus_id");--> statement-breakpoint
CREATE INDEX "files_client_idx" ON "files" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "files_portal_idx" ON "files" USING btree ("portal_id");--> statement-breakpoint
CREATE INDEX "files_session_idx" ON "files" USING btree ("upload_session_id");--> statement-breakpoint
CREATE INDEX "files_status_idx" ON "files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "files_created_idx" ON "files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "files_checksum_idx" ON "files" USING btree ("checksum_sha256");--> statement-breakpoint
CREATE INDEX "files_client_path_idx" ON "files" USING btree ("client_id","relative_path","original_filename");--> statement-breakpoint
CREATE INDEX "files_name_trgm_idx" ON "files" USING gin ("original_filename" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_access_token_hash_uq" ON "portal_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "portal_access_portal_idx" ON "portal_access_tokens" USING btree ("portal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portals_token_hash_uq" ON "portals" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "portals_client_idx" ON "portals" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "portals_status_idx" ON "portals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "portals_created_idx" ON "portals" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_token_hash_uq" ON "upload_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "upload_sessions_portal_idx" ON "upload_sessions" USING btree ("portal_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_client_idx" ON "upload_sessions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_status_idx" ON "upload_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "upload_sessions_started_idx" ON "upload_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "upload_sessions_activity_idx" ON "upload_sessions" USING btree ("last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));