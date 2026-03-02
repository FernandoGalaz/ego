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
  .option("-d, --detail <taskId>", "Show detailed phase log for a task")
  .action(async (opts: { project?: string; detail?: string }) => {
    initDb();
    const db = getDb();

    // Detailed view for a specific task
    if (opts.detail) {
      const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, opts.detail)).limit(1);
      if (task.length === 0) {
        console.log(`\nTask ${opts.detail} not found.\n`);
        await closeDb();
        return;
      }

      const t = task[0];
      const elapsed = t.startedAt ? formatElapsed(new Date(t.startedAt), t.completedAt ? new Date(t.completedAt) : new Date()) : "-";

      console.log(`\n  Task: ${t.id}`);
      console.log("  " + "─".repeat(60));
      console.log(`  Project:  ${t.project}`);
      console.log(`  Title:    ${t.title}`);
      console.log(`  Status:   ${statusEmoji(t.status)} ${t.status}`);
      console.log(`  Phase:    ${t.currentPhase ?? "-"}`);
      console.log(`  Priority: P${t.priority}`);
      console.log(`  Source:   ${t.source}`);
      console.log(`  Branch:   ${t.branch ?? "-"}`);
      console.log(`  Turns:    ${t.turnsUsed ?? 0}`);
      console.log(`  Elapsed:  ${elapsed}`);
      if (t.failedPhase) console.log(`  Failed:   ${t.failedPhase}`);
      if (t.result) console.log(`  Result:   ${t.result.slice(0, 200)}`);

      // Show phase log
      const phases = await db.select().from(schema.phaseLog).where(eq(schema.phaseLog.taskId, opts.detail)).orderBy(schema.phaseLog.id);

      if (phases.length > 0) {
        console.log("\n  Phase log:");
        console.log("  " + "─".repeat(60));
        for (const p of phases) {
          const dur = p.durationMs ? `${Math.round(p.durationMs / 1000)}s` : "-";
          const turns = p.turnsUsed ? ` (${p.turnsUsed} turns)` : "";
          const icon = p.status === "completed" ? "✅" : p.status === "failed" ? "❌" : "▶️";
          console.log(`  ${icon} ${p.phase.padEnd(10)} ${p.status.padEnd(10)} ${dur}${turns}`);
          if (p.error) console.log(`     Error: ${p.error.slice(0, 100)}`);
        }
      }

      console.log("  " + "─".repeat(60) + "\n");
      await closeDb();
      return;
    }

    const tasks = await db
      .select()
      .from(schema.tasks)
      .orderBy(desc(schema.tasks.createdAt))
      .limit(10);

    if (tasks.length === 0) {
      console.log("\nNo tasks found.\n");
      await closeDb();
      return;
    }

    console.log("\n  Recent tasks:");
    console.log("  " + "─".repeat(90));

    for (const task of tasks) {
      if (opts.project && task.project !== opts.project) continue;

      const status = statusEmoji(task.status);
      const phase = task.currentPhase ? ` [${task.currentPhase}]` : "";
      const elapsed = task.status === "working" && task.startedAt
        ? ` (${formatElapsed(new Date(task.startedAt), new Date())})`
        : task.startedAt && task.completedAt
          ? ` (${formatElapsed(new Date(task.startedAt), new Date(task.completedAt))})`
          : "";
      const turns = task.turnsUsed ? ` ${task.turnsUsed}t` : "";
      console.log(
        `  ${status} ${task.id}  ${task.project.padEnd(12)}  P${task.priority}  ${task.title.slice(0, 40).padEnd(40)}${phase}${elapsed}${turns}`
      );
    }

    console.log("  " + "─".repeat(90));
    console.log("  Use --detail <taskId> for phase-by-phase breakdown\n");

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

function formatElapsed(start: Date, end: Date): string {
  const totalSec = Math.round((end.getTime() - start.getTime()) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

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
