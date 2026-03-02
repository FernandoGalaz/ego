import * as linear from "../integrations/linear.js";
import * as sentry from "../integrations/sentry.js";
import { notify } from "../integrations/notifications.js";
import { cleanupWorktree } from "./worktree.js";
import { phaseLogger } from "../utils/logger.js";
import type { PipelineContext, PhaseResult } from "./index.js";

export async function executeReport(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "report");
  const start = Date.now();

  try {
    // Linear — final summary + state change
    if (ctx.source === "linear" && ctx.sourceId) {
      await linear.addComment(
        ctx.sourceId,
        `📊 **Ego — Resumen final**\n\n` +
          `- Estado: ✅ Completado\n` +
          `- Branch: \`${ctx.branch}\`\n` +
          `- Turns totales: ${ctx.totalTurns}\n` +
          `- Proyecto: ${ctx.projectName}\n\n` +
          `La branch está lista para review. Merge manual a main.`
      );

      await linear.updateIssueState(ctx.sourceId, "Ego Done");
      await linear.assignIssue(ctx.sourceId, "fb0bf1f6-f5d8-4a18-8b0d-5dec7ad78556"); // fernando@kubuz.cl
      log.info("Linear issue moved to Ego Done and assigned to Fernando");
    }

    // Sentry — comment with fix link
    if (ctx.source === "sentry" && ctx.sourceId && ctx.project.sentry) {
      const ghRepo = ctx.project.github.repo;
      const branchUrl = `https://github.com/${ghRepo}/tree/${ctx.branch}`;
      await sentry.addComment(
        ctx.project.sentry.org,
        ctx.sourceId,
        `🤖 Ego fix: branch [${ctx.branch}](${branchUrl}) — ${ctx.totalTurns} turns`
      );
    }

    // Cleanup worktree + release lock
    await cleanupWorktree(ctx);

    log.info("Report phase completed");

    return {
      success: true,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const error = err as Error;
    log.error({ error: error.message }, "Report phase failed (non-critical)");

    // Still try to clean up
    try {
      await cleanupWorktree(ctx);
    } catch {
      log.warn("Failed to cleanup worktree during report error handling");
    }

    // Report failure is non-critical — task itself was successful
    return {
      success: true, // Don't fail the entire pipeline just because reporting failed
      error: error.message,
      durationMs: Date.now() - start,
    };
  }
}
