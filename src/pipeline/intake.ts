import * as linear from "../integrations/linear.js";
import { phaseLogger } from "../utils/logger.js";
import type { PipelineContext, PhaseResult } from "./index.js";

export async function executeIntake(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "intake");
  const start = Date.now();

  try {
    if (ctx.source === "linear" && ctx.sourceId) {
      // Fetch comments before changing state (includes user review feedback)
      const comments = await linear.getComments(ctx.sourceId);
      const formattedComments = linear.formatCommentsForPrompt(comments);
      if (formattedComments) {
        ctx.comments = formattedComments;
        log.info({ count: comments.length }, "Loaded comments from Linear issue");
      }

      // Update Linear state to "Ego Working"
      await linear.updateIssueState(ctx.sourceId, "Ego Working");
      await linear.addComment(
        ctx.sourceId,
        `🤖 **Ego** — Tarea recibida\n\n- Prioridad: P${ctx.taskId}\n- Branch: \`${ctx.branch}\`\n- Pipeline iniciando...`
      );

      log.info({ linearId: ctx.sourceId }, "Linear issue updated to Ego Working");
    }

    if (ctx.source === "sentry") {
      log.info({ sentryId: ctx.sourceId }, "Sentry event intake — processing");
    }

    if (ctx.source === "cli") {
      log.info("CLI manual task intake");
    }

    return {
      success: true,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const error = err as Error;
    log.error({ error: error.message }, "Intake failed");
    return {
      success: false,
      error: error.message,
      durationMs: Date.now() - start,
    };
  }
}
