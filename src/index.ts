import { Command } from "commander";
import { nanoid } from "nanoid";
import { loadProject, loadAllProjects, loadEgoConfig } from "./config.js";
import { initDb, getDb, schema, closeDb } from "./db/index.js";
import { enqueueTask, getQueue, closeQueue } from "./queue/index.js";
import { startWorker, stopWorker } from "./queue/worker.js";
import { startServer } from "./server.js";
import { releaseLock, readLock } from "./utils/lock.js";
import { resetFailures } from "./utils/safety.js";
import { logger } from "./utils/logger.js";
import { eq, desc } from "drizzle-orm";
import { executeDryRun } from "./dry-run.js";

const program = new Command();

program
  .name("ego")
  .description("Ego — autonomous coding agent")
  .version("0.1.0");

// ─── ego start ──────────────────────────────────────
program
  .command("start")
  .description("Start Ego server (webhooks + worker)")
  .option("-v, --verbose", "Enable debug logging")
  .action((opts: { verbose?: boolean }) => {
    if (opts.verbose) logger.level = "debug";
    startServer();
  });

// ─── ego task ───────────────────────────────────────
program
  .command("task")
  .description("Submit a manual task (P0 — immediate)")
  .requiredOption("-p, --project <name>", "Project name")
  .argument("<description>", "Task description")
  .action(async (description: string, opts: { project: string }) => {
    initDb();

    const project = loadProject(opts.project);
    const taskId = nanoid(12);
    const db = getDb();

    await db.insert(schema.tasks).values({
      id: taskId,
      project: opts.project,
      source: "cli",
      title: description,
      priority: 0, // P0 — manual, always first
      createdAt: new Date().toISOString(),
    });

    await enqueueTask({
      taskId,
      project: opts.project,
      source: "cli",
      title: description,
      priority: 0,
    });

    logger.info({ taskId, project: opts.project }, "Manual task enqueued (P0)");
    console.log(`\nTask ${taskId} enqueued for project ${opts.project}`);
    console.log(`Priority: P0 (manual — immediate)\n`);

    // Start worker if not already running
    startWorker();
  });

// ─── ego status ─────────────────────────────────────
program
  .command("status")
  .description("Show current task status")
  .option("-p, --project <name>", "Filter by project")
  .action(async (opts: { project?: string }) => {
    initDb();
    const db = getDb();

    let query = db
      .select()
      .from(schema.tasks)
      .orderBy(desc(schema.tasks.createdAt))
      .limit(10);

    const tasks = await query;

    if (tasks.length === 0) {
      console.log("\nNo tasks found.\n");
      return;
    }

    console.log("\n  Recent tasks:");
    console.log("  " + "─".repeat(80));

    for (const task of tasks) {
      if (opts.project && task.project !== opts.project) continue;

      const status = statusEmoji(task.status);
      const phase = task.currentPhase ? ` [${task.currentPhase}]` : "";
      console.log(
        `  ${status} ${task.id}  ${task.project}  P${task.priority}  ${task.title.slice(0, 50)}${phase}`
      );
    }

    console.log("  " + "─".repeat(80) + "\n");

    await closeDb();
  });

// ─── ego cancel ─────────────────────────────────────
program
  .command("cancel")
  .description("Cancel a queued task")
  .argument("<taskId>", "Task ID to cancel")
  .action(async (taskId: string) => {
    initDb();
    const db = getDb();

    await db
      .update(schema.tasks)
      .set({ status: "cancelled", completedAt: new Date().toISOString() })
      .where(eq(schema.tasks.id, taskId));

    // Try to remove from queue
    try {
      const queue = getQueue();
      const job = await queue.getJob(taskId);
      if (job) await job.remove();
    } catch {
      // Job might already be processing
    }

    logger.info({ taskId }, "Task cancelled");
    console.log(`\nTask ${taskId} cancelled.\n`);
  });

// ─── ego unlock ─────────────────────────────────────
program
  .command("unlock")
  .description("Force-release the git lock for a project")
  .requiredOption("-p, --project <name>", "Project name")
  .action(async (opts: { project: string }) => {
    const project = loadProject(opts.project);
    const lock = readLock(project.repo);

    if (lock) {
      releaseLock(project.repo);
      console.log(`\nLock released for ${opts.project}`);
      console.log(`  Was: task ${lock.taskId} (started ${lock.startedAt})\n`);
    } else {
      console.log(`\nNo lock found for ${opts.project}.\n`);
    }
  });

// ─── ego projects ───────────────────────────────────
program
  .command("projects")
  .description("List configured projects")
  .action(() => {
    const projects = loadAllProjects();

    if (projects.size === 0) {
      console.log("\nNo projects configured. Add JSON files to projects/ directory.\n");
      return;
    }

    console.log("\n  Configured projects:");
    console.log("  " + "─".repeat(60));

    for (const [name, config] of projects) {
      console.log(`  📁 ${name}`);
      console.log(`     Repo: ${config.repo}`);
      console.log(`     Linear team: ${config.linear.teamId}`);
      if (config.sentry) console.log(`     Sentry: ${config.sentry.org}/${config.sentry.project}`);
      if (config.coolify) console.log(`     Coolify: ${config.coolify.devUrl}`);
      console.log(`     GitHub: ${config.github.repo}`);
      console.log();
    }
  });

// ─── ego dry-run ────────────────────────────────────
program
  .command("dry-run")
  .description("Verify all external connections for a project")
  .requiredOption("-p, --project <name>", "Project name")
  .action(async (opts: { project: string }) => {
    await executeDryRun(opts.project);
  });

// ─── ego reset ──────────────────────────────────────
program
  .command("reset")
  .description("Reset safety counters (circuit breaker)")
  .action(() => {
    resetFailures();
    console.log("\nSafety counters reset.\n");
  });

function statusEmoji(status: string): string {
  switch (status) {
    case "queued":
      return "⏳";
    case "working":
      return "🔄";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "cancelled":
      return "⛔";
    default:
      return "❓";
  }
}

program.parse();
