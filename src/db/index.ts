import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import * as schema from "./schema.js";
import { logger } from "../utils/logger.js";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

function getDbPath(): string {
  const dataDir = process.env.EGO_DATA_DIR ?? join(process.cwd(), "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "ego.db");
}

export function getDb() {
  if (_db) return _db;

  const dbPath = getDbPath();
  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

  _db = drizzle(_sqlite, { schema });
  logger.info({ path: dbPath }, "Database connected");
  return _db;
}

export function initDb(): void {
  const db = getDb();

  // Create tables directly via SQL (simpler than drizzle-kit for embedded use)
  _sqlite!.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('linear', 'sentry', 'cli')),
      source_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'working', 'completed', 'failed', 'cancelled')),
      current_phase TEXT,
      branch TEXT,
      worktree_path TEXT,
      plan_json TEXT,
      result TEXT,
      failed_phase TEXT,
      turns_used INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS phase_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      phase TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed')),
      output TEXT,
      error TEXT,
      turns_used INTEGER,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sentry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,
      project TEXT NOT NULL,
      event_id TEXT NOT NULL,
      title TEXT,
      level TEXT,
      task_id TEXT REFERENCES tasks(id),
      received_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
    CREATE INDEX IF NOT EXISTS idx_phase_log_task ON phase_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_sentry_fingerprint ON sentry_events(fingerprint);
  `);

  logger.info("Database tables initialized");
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export { schema };
