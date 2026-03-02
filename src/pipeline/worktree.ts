import { execFile } from "child_process";
import { promisify } from "util";
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { phaseLogger } from "../utils/logger.js";
import type { PipelineContext, PhaseResult } from "./index.js";

const exec = promisify(execFile);

export async function executeWorktree(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "worktree");
  const start = Date.now();

  const repoDir = ctx.project.repo;
  const worktreesBase = resolve(repoDir, ctx.project.worktreesDir);
  const worktreePath = join(worktreesBase, `ego-${ctx.taskId}`);
  const branch = ctx.branch;

  try {
    // Ensure worktrees directory exists
    if (!existsSync(worktreesBase)) {
      mkdirSync(worktreesBase, { recursive: true });
    }

    // Acquire lock on the main repo
    if (!acquireLock(repoDir, ctx.taskId, ctx.projectName)) {
      return {
        success: false,
        error: "Failed to acquire lock — another task may be running",
        durationMs: Date.now() - start,
      };
    }

    // Fetch latest from origin
    log.info("Fetching latest from origin");
    await exec("git", ["fetch", "origin"], { cwd: repoDir });

    // Create worktree from main
    log.info({ worktreePath, branch }, "Creating worktree");
    const baseBranch = ctx.project.baseBranch;
    await exec("git", ["worktree", "add", worktreePath, "-b", branch, `origin/${baseBranch}`], {
      cwd: repoDir,
    });

    // Store worktree path in context
    ctx.worktreePath = worktreePath;

    log.info({ worktreePath }, "Worktree created successfully");

    return {
      success: true,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const error = err as Error;
    log.error({ error: error.message }, "Worktree creation failed");

    // Release lock if worktree creation failed
    releaseLock(repoDir);

    return {
      success: false,
      error: error.message,
      durationMs: Date.now() - start,
    };
  }
}

export async function reuseWorktree(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "worktree-reuse");
  const start = Date.now();

  const repoDir = ctx.project.repo;

  try {
    // Verify worktree path exists on disk
    if (!ctx.worktreePath || !existsSync(ctx.worktreePath)) {
      return {
        success: false,
        error: `Worktree not found at ${ctx.worktreePath} — cannot resume`,
        durationMs: Date.now() - start,
      };
    }

    // Verify it's a valid git repo
    await exec("git", ["status", "--porcelain"], { cwd: ctx.worktreePath });

    // Re-acquire lock (lock.ts allows re-acquire for same taskId)
    if (!acquireLock(repoDir, ctx.taskId, ctx.projectName)) {
      return {
        success: false,
        error: "Failed to re-acquire lock for retry",
        durationMs: Date.now() - start,
      };
    }

    // Fetch latest from origin
    log.info("Fetching latest from origin");
    await exec("git", ["fetch", "origin"], { cwd: repoDir });

    log.info({ worktreePath: ctx.worktreePath }, "Existing worktree reused for retry");

    return {
      success: true,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const error = err as Error;
    log.error({ error: error.message }, "Worktree reuse failed");
    return {
      success: false,
      error: error.message,
      durationMs: Date.now() - start,
    };
  }
}

export async function cleanupWorktree(ctx: PipelineContext): Promise<void> {
  const log = phaseLogger(ctx.taskId, "worktree-cleanup");

  try {
    if (ctx.worktreePath && existsSync(ctx.worktreePath)) {
      await exec("git", ["worktree", "remove", ctx.worktreePath, "--force"], {
        cwd: ctx.project.repo,
      });
      log.info({ path: ctx.worktreePath }, "Worktree removed");
    }
  } catch (err) {
    log.warn({ error: (err as Error).message }, "Failed to remove worktree");
  }

  // Always release lock
  releaseLock(ctx.project.repo);
}
