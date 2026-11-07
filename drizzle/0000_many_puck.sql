CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`rating` text NOT NULL,
	`mode` text NOT NULL,
	`note` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_salt` text NOT NULL,
	`session_version` text NOT NULL,
	`updated_at` integer NOT NULL
);
