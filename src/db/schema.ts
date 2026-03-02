import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(), // nanoid
  project: text("project").notNull(),
  source: text("source", { enum: ["linear", "sentry", "cli"] }).notNull(),
  sourceId: text("source_id"), // Linear issue ID or Sentry event ID
  title: text("title").notNull(),
  description: text("description"),
  priority: integer("priority").notNull().default(3), // P0-P4
  status: text("status", {
    enum: ["queued", "working", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("queued"),
  currentPhase: text("current_phase"),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  planJson: text("plan_json"), // Stored as JSON string
  result: text("result"), // Final result/error message
  failedPhase: text("failed_phase"),
  turnsUsed: integer("turns_used").default(0),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

export const phaseLog = sqliteTable("phase_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  phase: text("phase").notNull(),
  status: text("status", { enum: ["started", "completed", "failed"] }).notNull(),
  output: text("output"), // JSON output from claude
  error: text("error"),
  turnsUsed: integer("turns_used"),
  durationMs: integer("duration_ms"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const sentryEvents = sqliteTable("sentry_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fingerprint: text("fingerprint").notNull(),
  project: text("project").notNull(),
  eventId: text("event_id").notNull(),
  title: text("title"),
  level: text("level"),
  taskId: text("task_id").references(() => tasks.id),
  receivedAt: text("received_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  processedAt: text("processed_at"),
});

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type PhaseLogEntry = typeof phaseLog.$inferSelect;
export type SentryEvent = typeof sentryEvents.$inferSelect;
