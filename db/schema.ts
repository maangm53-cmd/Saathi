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
