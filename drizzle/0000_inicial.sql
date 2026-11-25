CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`paused_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_unique` ON `agents` (`slug`);--> statement-breakpoint
CREATE TABLE `attention` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text,
	`group_id` text,
	`routine_id` text,
	`text` text NOT NULL,
	`tool` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attention_open_idx` ON `attention` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`group_id` text,
	`claude_session_id` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_agent_idx` ON `conversations` (`agent_id`);--> statement-breakpoint
CREATE INDEX `conversations_group_idx` ON `conversations` (`group_id`);--> statement-breakpoint
CREATE TABLE `followups` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`reason` text NOT NULL,
	`instruction` text,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `followups_due_idx` ON `followups` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`coordinator` integer DEFAULT false NOT NULL,
	`claude_session_id` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `agent_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`folder` text NOT NULL,
	`objective` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_slug_unique` ON `groups` (`slug`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`author` text NOT NULL,
	`agent_id` text,
	`text` text NOT NULL,
	`parts` text NOT NULL,
	`meta` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`title` text NOT NULL,
	`instruction` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text NOT NULL,
	`mode` text DEFAULT 'act' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`enabled_at` integer NOT NULL,
	`failure_streak` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routines_due_idx` ON `routines` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `routines_agent_title_unique` ON `routines` (`agent_id`,`title`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`routine_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`duration_ms` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_agent_idx` ON `runs` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_routine_idx` ON `runs` (`routine_id`,`started_at`);