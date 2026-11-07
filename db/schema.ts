import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  encryptedKey: text("encrypted_key").notNull(),
  codeHash: text("code_hash").notNull(),
  codeSalt: text("code_salt").notNull(),
  sessionVersion: text("session_version").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const feedback = sqliteTable("feedback", {
  id: text("id").primaryKey(),
  rating: text("rating").notNull(),
  mode: text("mode").notNull(),
  note: text("note").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const calendarConfig = sqliteTable("calendar_config", {
  id: text("id").primaryKey(),
  encryptedConnection: text("encrypted_connection").notNull(),
  selectedIds: text("selected_ids").notNull(),
  revision: text("revision").notNull(),
  timeZone: text("time_zone").notNull(),
  reminderMinutes: integer("reminder_minutes").notNull(),
  lastSyncedAt: integer("last_synced_at"),
  lastError: text("last_error"),
  syncToken: text("sync_token"),
  syncUntil: integer("sync_until"),
});
export const appointments = sqliteTable("appointments", {
  id: text("id").primaryKey(),
  revision: text("revision").notNull(),
  startAt: integer("start_at").notNull(),
  endAt: integer("end_at").notNull(),
  allDay: integer("all_day").notNull(),
  encryptedDetails: text("encrypted_details").notNull(),
  syncedAt: integer("synced_at").notNull(),
});
export const pushKeys = sqliteTable("push_keys", {
  id: text("id").primaryKey(),
  encryptedKeys: text("encrypted_keys").notNull(),
});
export const pushDevices = sqliteTable("push_devices", {
  id: text("id").primaryKey(),
  endpointHash: text("endpoint_hash").notNull().unique(),
  encryptedSubscription: text("encrypted_subscription").notNull(),
  sessionVersion: text("session_version").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const reminderDeliveries = sqliteTable("reminder_deliveries", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  deviceId: text("device_id").notNull(),
  dueAt: integer("due_at").notNull(),
  state: text("state").notNull(),
  leaseUntil: integer("lease_until").notNull(),
  attempts: integer("attempts").notNull(),
  sentAt: integer("sent_at"),
});
export const reminderRunner = sqliteTable("reminder_runner", {
  id: text("id").primaryKey(),
  token: text("token"),
  leaseUntil: integer("lease_until").notNull().default(0),
  lastRunAt: integer("last_run_at"),
  lastSuccessAt: integer("last_success_at"),
  lastOutcome: text("last_outcome"),
  scheduleId: text("schedule_id"),
});
