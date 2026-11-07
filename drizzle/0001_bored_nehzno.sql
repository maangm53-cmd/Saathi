CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`all_day` integer NOT NULL,
	`encrypted_details` text NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calendar_config` (
	`id` text PRIMARY KEY NOT NULL,
	`encrypted_connection` text NOT NULL,
	`selected_ids` text NOT NULL,
	`revision` text NOT NULL,
	`time_zone` text NOT NULL,
	`reminder_minutes` integer NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`sync_token` text,
	`sync_until` integer
);
--> statement-breakpoint
CREATE TABLE `push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_hash` text NOT NULL,
	`encrypted_subscription` text NOT NULL,
	`session_version` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_endpoint_hash_unique` ON `push_devices` (`endpoint_hash`);--> statement-breakpoint
CREATE TABLE `push_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`encrypted_keys` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reminder_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`device_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`state` text NOT NULL,
	`lease_until` integer NOT NULL,
	`attempts` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE TABLE `reminder_runner` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`last_outcome` text,
	`schedule_id` text
);
