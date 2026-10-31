CREATE TABLE "memento_chat_participant" (
	"tenant_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" varchar(200) NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_event_id" uuid,
	"last_seen_at" timestamp (3) with time zone,
	CONSTRAINT "memento_chat_participant_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);--> statement-breakpoint
ALTER TABLE "memento_chat_participant" ADD CONSTRAINT "memento_chat_participant_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_chat_participant" ADD CONSTRAINT "memento_chat_participant_chat_id_memento_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."memento_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memento_chat_participant_user_idx" ON "memento_chat_participant" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "memento_chat" ADD COLUMN "kind" varchar(16) DEFAULT 'room' NOT NULL;--> statement-breakpoint
ALTER TABLE "memento_chat" ADD COLUMN "name" varchar(200);--> statement-breakpoint
ALTER TABLE "memento_chat" ADD COLUMN "last_message_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "memento_chat" ADD CONSTRAINT "memento_chat_kind_check" CHECK ("memento_chat"."kind" in ('direct', 'room'));--> statement-breakpoint
-- Backfill: rename title -> name, move the participants array into memento_chat_participant,
-- derive last_message_at from the chat's messages. Existing chats stay `room` (members can be added).
UPDATE "memento_chat" SET "name" = "title";--> statement-breakpoint
INSERT INTO "memento_chat_participant" ("tenant_id", "chat_id", "user_id", "added_at")
SELECT c."tenant_id", c."id", p."user_id", c."created_at"
FROM "memento_chat" c CROSS JOIN LATERAL unnest(c."participants") AS p("user_id")
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "memento_chat" c SET "last_message_at" = (
  SELECT max(e."occurred_at") FROM "memento_event" e
  WHERE e."tenant_id" = c."tenant_id" AND e."instance_type" = 'chat'
    AND e."instance_id" = c."instance_id" AND e."event_type" = 'CHAT_MESSAGE_SENT'
);--> statement-breakpoint
ALTER TABLE "memento_chat" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "memento_chat" DROP COLUMN "participants";
