CREATE TABLE "memento_apikey" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"prefix" varchar(16) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "memento_apikey_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "memento_chat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" varchar(200) NOT NULL,
	"title" varchar(200),
	"participants" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memento_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"instance_type" varchar(64) NOT NULL,
	"instance_id" varchar(200) NOT NULL,
	"actor_id" varchar(200),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rendered" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memento_seen" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" varchar(200) NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memento_seen_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "memento_star" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" varchar(200) NOT NULL,
	"note" text,
	"starred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memento_star_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "memento_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"locale" varchar(35) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memento_tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memento_tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "memento_apikey" ADD CONSTRAINT "memento_apikey_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_chat" ADD CONSTRAINT "memento_chat_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_event" ADD CONSTRAINT "memento_event_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_seen" ADD CONSTRAINT "memento_seen_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_seen" ADD CONSTRAINT "memento_seen_event_id_memento_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."memento_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_star" ADD CONSTRAINT "memento_star_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_star" ADD CONSTRAINT "memento_star_event_id_memento_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."memento_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_template" ADD CONSTRAINT "memento_template_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memento_apikey_tenant_idx" ON "memento_apikey" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memento_chat_instance_key" ON "memento_chat" USING btree ("tenant_id","instance_id");--> statement-breakpoint
CREATE INDEX "memento_event_tenant_time_idx" ON "memento_event" USING btree ("tenant_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memento_event_entity_idx" ON "memento_event" USING btree ("tenant_id","instance_type","instance_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memento_event_type_idx" ON "memento_event" USING btree ("tenant_id","event_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memento_event_actor_idx" ON "memento_event" USING btree ("tenant_id","actor_id","occurred_at" DESC NULLS LAST) WHERE "memento_event"."actor_id" is not null;--> statement-breakpoint
CREATE INDEX "memento_seen_user_idx" ON "memento_seen" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memento_star_user_idx" ON "memento_star" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memento_template_key" ON "memento_template" USING btree ("tenant_id","event_type","locale");