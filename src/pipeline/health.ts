import * as coolify from "../integrations/coolify.js";
import * as linear from "../integrations/linear.js";
import { phaseLogger } from "../utils/logger.js";
import type { PipelineContext, PhaseResult } from "./index.js";

export async function executeHealthCheck(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "health");
  const start = Date.now();

  if (!ctx.project.coolify) {
    log.info("No Coolify config — skipping health check");
    return { success: true, durationMs: Date.now() - start };
  }

  try {
    // Wait for Coolify to deploy (auto-deploy from branch push)
    log.info("Waiting 60s for Coolify deploy...");
    await new Promise((r) => setTimeout(r, 60_000));

    // Health check
    const health = await coolify.checkHealth(ctx.project);
    if (!health.healthy) {
      log.error({ error: health.error }, "Health check failed");

      if (ctx.source === "linear" && ctx.sourceId) {
        await linear.addComment(
          ctx.sourceId,
          `❌ **Ego — Health check failed**\n\n${health.error}`
        );
      }

      return {
        success: false,
        error: health.error ?? "Health check failed",
        durationMs: Date.now() - start,
      };
    }

    // Check recent logs for errors
    const logs = await coolify.getRecentLogs(ctx.project);
    if (logs.hasErrors) {
      log.error("Fatal errors found in Coolify logs");

      if (ctx.source === "linear" && ctx.sourceId) {
        await linear.addComment(
          ctx.sourceId,
          `❌ **Ego — Deploy errors**\n\nFatal errors found in logs after deploy.`
        );
      }

      return {
        success: false,
        error: "Fatal errors in deploy logs",
        durationMs: Date.now() - start,
      };
    }

    log.info("Health check passed — deploy is healthy");

    if (ctx.source === "linear" && ctx.sourceId) {
      await linear.addComment(
        ctx.sourceId,
        `🏥 **Ego — Deploy dev OK**\n\n` +
          `- URL: ${ctx.project.coolify.devUrl}\n` +
          `- Health: ✅ 200 OK\n` +
          `- Logs: clean`
      );
    }

    return {
      success: true,
      output: { healthy: true, devUrl: ctx.project.coolify.devUrl },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: error.message,
      durationMs: Date.now() - start,
    };
  }
}
