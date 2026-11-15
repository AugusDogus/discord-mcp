PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_discord_account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`discord_user_id` text,
	`dek_id` text NOT NULL,
	`token_enc` text NOT NULL,
	`profile_enc` text NOT NULL,
	`status` text NOT NULL,
	`presence_on_write` integer DEFAULT false NOT NULL,
	`last_verified_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "discord_account_status_check" CHECK("__new_discord_account"."status" in ('active', 'rejected'))
);
--> statement-breakpoint
-- The existing account (one per user) keeps its sealed token and profile. Its id
-- is the user's id, the row key those envelopes were sealed under. Its Discord
-- user id is inside the sealed profile, so the app fills it in on the next check.
INSERT INTO `__new_discord_account`("id", "user_id", "discord_user_id", "dek_id", "token_enc", "profile_enc", "status", "presence_on_write", "last_verified_at", "created_at", "updated_at") SELECT "user_id", "user_id", NULL, "dek_id", "token_enc", "profile_enc", "status", "presence_on_write", "last_verified_at", "created_at", "updated_at" FROM `discord_account`;--> statement-breakpoint
DROP TABLE `discord_account`;--> statement-breakpoint
ALTER TABLE `__new_discord_account` RENAME TO `discord_account`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `discord_account_user_discord_user_unique` ON `discord_account` (`user_id`,`discord_user_id`);--> statement-breakpoint
ALTER TABLE `oauth_grant` ADD `discord_account_id` text REFERENCES discord_account(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
-- Existing agent grants act as their user's existing account.
UPDATE `oauth_grant` SET `discord_account_id` = (SELECT `id` FROM `discord_account` WHERE `discord_account`.`user_id` = `oauth_grant`.`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_grant_discord_account_idx` ON `oauth_grant` (`discord_account_id`);