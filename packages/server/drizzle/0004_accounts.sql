CREATE TABLE "memento_session" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" varchar(400),
	"ip" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "memento_tenant_user" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memento_tenant_user_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "memento_tenant_user_role_check" CHECK ("memento_tenant_user"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "memento_user_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memento_user_token_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "memento_user_token_kind_check" CHECK ("memento_user_token"."kind" in ('verify', 'reset'))
);
--> statement-breakpoint
CREATE TABLE "memento_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text NOT NULL,
	"name" varchar(200) NOT NULL,
	"locale" varchar(8) DEFAULT 'en' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"terms_accepted_at" timestamp with time zone NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "memento_user_email_unique" UNIQUE("email"),
	CONSTRAINT "memento_user_locale_check" CHECK ("memento_user"."locale" in ('en', 'sr'))
);
--> statement-breakpoint
ALTER TABLE "memento_tenant" ADD COLUMN "plan" varchar(32) DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "memento_tenant" ADD COLUMN "max_keys" integer;--> statement-breakpoint
ALTER TABLE "memento_tenant" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "memento_session" ADD CONSTRAINT "memento_session_user_id_memento_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."memento_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_session" ADD CONSTRAINT "memento_session_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_tenant_user" ADD CONSTRAINT "memento_tenant_user_tenant_id_memento_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."memento_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_tenant_user" ADD CONSTRAINT "memento_tenant_user_user_id_memento_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."memento_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memento_user_token" ADD CONSTRAINT "memento_user_token_user_id_memento_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."memento_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memento_session_user_idx" ON "memento_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memento_session_expires_idx" ON "memento_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "memento_tenant_user_user_idx" ON "memento_tenant_user" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memento_user_token_user_idx" ON "memento_user_token" USING btree ("user_id");