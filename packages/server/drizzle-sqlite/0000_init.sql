CREATE TABLE `memento_apikey_usage` (
	`api_key_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`hour` integer NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`events_written` integer DEFAULT 0 NOT NULL,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`stream_seconds` integer DEFAULT 0 NOT NULL,
	`bytes_in` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`api_key_id`, `hour`),
	FOREIGN KEY (`api_key_id`) REFERENCES `memento_apikey`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memento_apikey_usage_tenant_idx` ON `memento_apikey_usage` (`tenant_id`,`hour`);--> statement-breakpoint
CREATE TABLE `memento_apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`disabled_at` integer,
	`deleted_at` integer,
	`daily_limit` integer,
	`created_by` text,
	`quota_warned_on` text,
	`quota_exceeded_on` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `memento_user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memento_apikey_prefix_unique` ON `memento_apikey` (`prefix`);--> statement-breakpoint
CREATE INDEX `memento_apikey_tenant_idx` ON `memento_apikey` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `memento_chat_participant` (
	`tenant_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`added_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_event_id` text,
	`last_seen_at` integer,
	PRIMARY KEY(`chat_id`, `user_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `memento_chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memento_chat_participant_user_idx` ON `memento_chat_participant` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `memento_chat` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`kind` text DEFAULT 'room' NOT NULL,
	`name` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_message_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memento_chat_kind_check" CHECK("memento_chat"."kind" in ('direct', 'room'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memento_chat_instance_key` ON `memento_chat` (`tenant_id`,`instance_id`);--> statement-breakpoint
CREATE TABLE `memento_event` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`received_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`event_type` text NOT NULL,
	`instance_type` text NOT NULL,
	`instance_id` text NOT NULL,
	`actor_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`rendered` text,
	`rendered_locale` text,
	`archived_at` integer,
	`api_key_id` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`api_key_id`) REFERENCES `memento_apikey`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `memento_event_apikey_idx` ON `memento_event` (`tenant_id`,`api_key_id`,`occurred_at`) WHERE "memento_event"."api_key_id" is not null;--> statement-breakpoint
CREATE INDEX `memento_event_tenant_time_idx` ON `memento_event` (`tenant_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `memento_event_entity_idx` ON `memento_event` (`tenant_id`,`instance_type`,`instance_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `memento_event_type_idx` ON `memento_event` (`tenant_id`,`event_type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `memento_event_actor_idx` ON `memento_event` (`tenant_id`,`actor_id`,`occurred_at`) WHERE "memento_event"."actor_id" is not null;--> statement-breakpoint
CREATE TABLE `memento_seen` (
	`tenant_id` text NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`event_id`, `user_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `memento_event`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memento_seen_user_idx` ON `memento_seen` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `memento_session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `memento_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memento_session_user_idx` ON `memento_session` (`user_id`);--> statement-breakpoint
CREATE INDEX `memento_session_expires_idx` ON `memento_session` (`expires_at`);--> statement-breakpoint
CREATE TABLE `memento_star` (
	`tenant_id` text NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`note` text,
	`starred_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`event_id`, `user_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `memento_event`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memento_star_user_idx` ON `memento_star` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `memento_template` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`event_type` text NOT NULL,
	`locale` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memento_template_key` ON `memento_template` (`tenant_id`,`event_type`,`locale`);--> statement-breakpoint
CREATE TABLE `memento_tenant_user` (
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`added_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`tenant_id`, `user_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `memento_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `memento_user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memento_tenant_user_role_check" CHECK("memento_tenant_user"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX `memento_tenant_user_user_idx` ON `memento_tenant_user` (`user_id`);--> statement-breakpoint
CREATE TABLE `memento_tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`max_keys` integer,
	`retention_days` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memento_tenant_slug_unique` ON `memento_tenant` (`slug`);--> statement-breakpoint
CREATE TABLE `memento_user_token` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memento_user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memento_user_token_kind_check" CHECK("memento_user_token"."kind" in ('verify', 'reset'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memento_user_token_token_hash_unique` ON `memento_user_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `memento_user_token_user_idx` ON `memento_user_token` (`user_id`);--> statement-breakpoint
CREATE TABLE `memento_user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`email_verified_at` integer,
	`terms_accepted_at` integer NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`disabled_at` integer,
	CONSTRAINT "memento_user_locale_check" CHECK("memento_user"."locale" in ('en', 'sr'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memento_user_email_unique` ON `memento_user` (`email`);