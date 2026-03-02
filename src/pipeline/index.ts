import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { loadProject, type ProjectConfig } from "../config.js";
import { phaseLogger } from "../utils/logger.js";
import { recordFailure } from "../utils/safety.js";
import { notify } from "../integrations/notifications.js";
import * as linear from "../integrations/linear.js";
import type { TaskJobData } from "../queue/index.js";

import { executeIntake } from "./intake.js";
import { executeWorktree } from "./worktree.js";
import { executePlan } from "./plan.js";
import { executeDev } from "./dev.js";
import { executeAudit } from "./audit.js";
import { executeCI } from "./ci.js";
import { executeHealthCheck } from "./health.js";
import { executeReport } from "./report.js";

export type PhaseName =
  | "intake"
  | "worktree"
  | "plan"
  | "dev"
  | "audit"
  | "ci"
  | "health"
  | "report";

export interface PhaseResult {
  success: boolean;
  output?: unknown;
  error?: string;
  turnsUsed?: number;
  durationMs?: number;
}

export interface PipelineContext {
  taskId: string;
  project: ProjectConfig;
  projectName: string;
  source: "linear" | "sentry" | "cli";
  sourceId?: string;
  title: string;
  description?: string;
  branch: string;
  worktreePath: string;
  planJson?: string;
  totalTurns: number;
}

async function logPhase(
  taskId: string,
  phase: string,
  status: "started" | "completed" | "failed",
  result?: PhaseResult
): Promise<void> {
  const db = getDb();
  await db.insert(schema.phaseLog).values({
    taskId,
    phase,
    status,
    output: result?.output ? JSON.stringify(result.output) : undefined,
    error: result?.error,
    turnsUsed: result?.turnsUsed,
    durationMs: result?.durationMs,
    createdAt: new Date().toISOString(),
  });
}

async function updateTask(
  taskId: string,
  updates: Partial<{
    status: "queued" | "working" | "completed" | "failed" | "cancelled";
    currentPhase: string;
    branch: string;
    worktreePath: string;
    planJson: string;
    result: string;
    failedPhase: string;
    turnsUsed: number;
    startedAt: string;
    completedAt: string;
  }>
): Promise<void> {
  const db = getDb();
  await db.update(schema.tasks).set(updates).where(eq(schema.tasks.id, taskId));
}

export async function executePipeline(jobData: TaskJobData): Promise<void> {
  const log = phaseLogger(jobData.taskId, "pipeline");
  const project = loadProject(jobData.project);

  const ctx: PipelineContext = {
    taskId: jobData.taskId,
    project,
    projectName: jobData.project,
    source: jobData.source,
    sourceId: jobData.sourceId,
    title: jobData.title,
    description: jobData.description,
    branch: `ego/${jobData.taskId}`,
    worktreePath: "",
    totalTurns: 0,
  };

  await updateTask(ctx.taskId, {
    status: "working",
    startedAt: new Date().toISOString(),
  });

  await notify({
    taskId: ctx.taskId,
    project: ctx.projectName,
    title: ctx.title,
    status: "started",
  });

  const phases: Array<{
    name: PhaseName;
    execute: (ctx: PipelineContext) => Promise<PhaseResult>;
  }> = [
    { name: "intake", execute: executeIntake },
    { name: "worktree", execute: executeWorktree },
    { name: "plan", execute: executePlan },
    { name: "dev", execute: executeDev },
    { name: "audit", execute: executeAudit },
    { name: "ci", execute: executeCI },
    { name: "health", execute: executeHealthCheck },
    { name: "report", execute: executeReport },
  ];

  for (const phase of phases) {
    log.info({ phase: phase.name }, `Starting phase: ${phase.name}`);
    await updateTask(ctx.taskId, { currentPhase: phase.name });
    await logPhase(ctx.taskId, phase.name, "started");

    try {
      const result = await phase.execute(ctx);
      ctx.totalTurns += result.turnsUsed ?? 0;

      if (!result.success) {
        log.error({ phase: phase.name, error: result.error }, "Phase failed");
        await logPhase(ctx.taskId, phase.name, "failed", result);
        recordFailure(ctx.taskId, phase.name);

        await updateTask(ctx.taskId, {
          status: "failed",
          failedPhase: phase.name,
          result: result.error ?? "Phase failed",
          turnsUsed: ctx.totalTurns,
          completedAt: new Date().toISOString(),
        });

        // Rollback Linear state so it can be retried
        if (ctx.source === "linear" && ctx.sourceId) {
          try {
            await linear.updateIssueState(ctx.sourceId, "Ready for Ego");
            log.info("Linear issue rolled back to Ready for Ego");
          } catch {
            log.warn("Failed to rollback Linear issue state");
          }
        }

        await notify({
          taskId: ctx.taskId,
          project: ctx.projectName,
          title: ctx.title,
          status: "failed",
          branch: ctx.branch,
          failedPhase: phase.name,
          turnsUsed: ctx.totalTurns,
        });

        return;
      }

      await logPhase(ctx.taskId, phase.name, "completed", result);
      log.info({ phase: phase.name, turns: result.turnsUsed }, "Phase completed");
    } catch (err) {
      const error = err as Error;
      const result: PhaseResult = { success: false, error: error.message };
      log.error({ phase: phase.name, error: error.message, stack: error.stack }, "Phase threw");

      await logPhase(ctx.taskId, phase.name, "failed", result);
      recordFailure(ctx.taskId, phase.name);

      await updateTask(ctx.taskId, {
        status: "failed",
        failedPhase: phase.name,
        result: error.message,
        turnsUsed: ctx.totalTurns,
        completedAt: new Date().toISOString(),
      });

      // Rollback Linear state so it can be retried
      if (ctx.source === "linear" && ctx.sourceId) {
        try {
          await linear.updateIssueState(ctx.sourceId, "Ready for Ego");
          log.info("Linear issue rolled back to Ready for Ego");
        } catch {
          log.warn("Failed to rollback Linear issue state");
        }
      }

      await notify({
        taskId: ctx.taskId,
        project: ctx.projectName,
        title: ctx.title,
        status: "failed",
        branch: ctx.branch,
        failedPhase: phase.name,
      });

      return;
    }
  }

  // Pipeline completed successfully
  await updateTask(ctx.taskId, {
    status: "completed",
    turnsUsed: ctx.totalTurns,
    completedAt: new Date().toISOString(),
  });

  await notify({
    taskId: ctx.taskId,
    project: ctx.projectName,
    title: ctx.title,
    status: "completed",
    branch: ctx.branch,
    turnsUsed: ctx.totalTurns,
  });

  log.info({ totalTurns: ctx.totalTurns }, "Pipeline completed successfully");
}
