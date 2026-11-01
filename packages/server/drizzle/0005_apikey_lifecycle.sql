CREATE TABLE "memento_apikey_usage" (
	"api_key_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"events_written" bigint DEFAULT 0 NOT NULL,
	"rows_read" bigint DEFAULT 0 NOT NULL,
	"stream_seconds" bigint DEFAULT 0 NOT NULL,
	"bytes_in" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "memento_apikey_usage_api_key_id_hour_pk" PRIMARY KEY("api_key_id","hour")
);
--> statement-breakpoint
ALTER TABLE "memento_apikey" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memento_apikey" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memento_apikey" ADD COLUMN "daily_limit" integer;--> statement-breakpoint
ALTER TABLE "memento_apikey" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "memento_apikey" ADD COLUMN "quota_warned_on" date;--> statement-breakpoint
ALTER TABLE "memento_apikey" ADD COLUMN "quota_exceeded_on" date;--> statement-breakpoint
ALTER TABLE "memento_event" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "memento_apikey_usage" ADD CONSTRAINT "memento_apikey_usage_api_key_id_memento_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."memento_apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memento_apikey_usage_tenant_idx" ON "memento_apikey_usage" USING btree ("tenant_id","hour");--> statement-breakpoint
ALTER TABLE "memento_apikey" ADD CONSTRAINT "memento_apikey_created_by_memento_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."memento_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_event" ADD CONSTRAINT "memento_event_api_key_id_memento_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."memento_apikey"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memento_event_apikey_idx" ON "memento_event" USING btree ("tenant_id","api_key_id","occurred_at" DESC NULLS LAST) WHERE "memento_event"."api_key_id" is not null;