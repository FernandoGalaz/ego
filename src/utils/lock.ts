import { existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger.js";

export interface LockInfo {
  taskId: string;
  project: string;
  startedAt: string;
  pid: number;
}

function lockPath(repoDir: string): string {
  return join(repoDir, ".ego-lock");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(repoDir: string, taskId: string, project: string): boolean {
  const lp = lockPath(repoDir);

  if (existsSync(lp)) {
    const existing = readLock(repoDir);

    if (existing && existing.taskId === taskId) {
      logger.info(
        { taskId, repoDir },
        "Re-acquiring lock for same task (retry)"
      );
      releaseLock(repoDir);
    } else if (existing && !isProcessAlive(existing.pid)) {
      logger.warn(
        { existing, repoDir },
        "Stale lock detected (PID dead) — releasing automatically"
      );
      releaseLock(repoDir);
    } else {
      logger.error(
        { existing, repoDir },
        "Lock already exists — another task is running. Use 'ego unlock' to force remove."
      );
      return false;
    }
  }

  const info: LockInfo = {
    taskId,
    project,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };

  writeFileSync(lp, JSON.stringify(info, null, 2));
  logger.info({ taskId, repoDir }, "Lock acquired");
  return true;
}

export function releaseLock(repoDir: string): void {
  const lp = lockPath(repoDir);
  if (existsSync(lp)) {
    unlinkSync(lp);
    logger.info({ repoDir }, "Lock released");
  }
}

export function readLock(repoDir: string): LockInfo | null {
  const lp = lockPath(repoDir);
  if (!existsSync(lp)) return null;
  try {
    return JSON.parse(readFileSync(lp, "utf-8"));
  } catch {
    return null;
  }
}

export function isLocked(repoDir: string): boolean {
  return existsSync(lockPath(repoDir));
}
