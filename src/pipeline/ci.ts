import * as github from "../integrations/github.js";
import { runClaude } from "../integrations/claude.js";
import * as linear from "../integrations/linear.js";
import { phaseLogger } from "../utils/logger.js";
import type { PipelineContext, PhaseResult } from "./index.js";

export async function executeCI(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "ci");
  const start = Date.now();

  try {
    // Push branch to origin
    log.info({ branch: ctx.branch }, "Pushing branch");
    await github.pushBranch(ctx.branch, ctx.worktreePath);

    // Wait for CI
    log.info("Waiting for CI...");
    const ciResult = await github.waitForCI(ctx.branch, ctx.worktreePath, 600_000);

    if (ciResult.success) {
      log.info("CI passed — creating PR");

      const prUrl = await github.createPR(
        {
          title: ctx.title,
          body: `🤖 **Ego — Automated PR**\n\n- Task: ${ctx.taskId}\n- Source: ${ctx.source}\n- Branch: \`${ctx.branch}\``,
          branch: ctx.branch,
          base: ctx.project.baseBranch,
        },
        ctx.worktreePath
      );

      log.info({ prUrl }, "PR created");

      // Auto-merge into baseBranch
      log.info("Auto-merging PR into " + ctx.project.baseBranch);
      await github.mergePR(prUrl, ctx.worktreePath);
      log.info("PR merged successfully");

      if (ctx.source === "linear" && ctx.sourceId) {
        await linear.addComment(
          ctx.sourceId,
          `✅ **Ego — CI passed & merged**\n\n` +
            `PR: ${prUrl}\n` +
            `Merged into \`${ctx.project.baseBranch}\``
        );
      }

      return {
        success: true,
        output: { ciPassed: true, prUrl, merged: true },
        durationMs: Date.now() - start,
      };
    }

    // CI failed — attempt one retry (build/lint only)
    log.warn("CI failed — attempting retry");
    const retryResult = await retryCIFix(ctx, ciResult.logs ?? "");

    if (retryResult.success) {
      // Push fix and wait again
      await github.pushBranch(ctx.branch, ctx.worktreePath);
      const secondRun = await github.waitForCI(ctx.branch, ctx.worktreePath, 600_000);

      if (secondRun.success) {
        log.info("CI passed after retry — creating PR");

        const prUrl = await github.createPR(
          {
            title: ctx.title,
            body: `🤖 **Ego — Automated PR**\n\n- Task: ${ctx.taskId}\n- Source: ${ctx.source}\n- Branch: \`${ctx.branch}\`\n- Note: CI passed after 1 retry`,
            branch: ctx.branch,
            base: ctx.project.baseBranch,
          },
          ctx.worktreePath
        );

        log.info({ prUrl }, "PR created after retry");

        // Auto-merge into baseBranch
        log.info("Auto-merging PR into " + ctx.project.baseBranch);
        await github.mergePR(prUrl, ctx.worktreePath);
        log.info("PR merged successfully after retry");

        if (ctx.source === "linear" && ctx.sourceId) {
          await linear.addComment(
            ctx.sourceId,
            `✅ **Ego — CI passed & merged** (after 1 retry)\n\n` +
              `PR: ${prUrl}\n` +
              `Merged into \`${ctx.project.baseBranch}\``
          );
        }

        return {
          success: true,
          output: { ciPassed: true, retried: true, prUrl, merged: true },
          turnsUsed: retryResult.turnsUsed,
          durationMs: Date.now() - start,
        };
      }
    }

    // CI still failing after retry
    log.error("CI failed after retry — giving up");

    if (ctx.source === "linear" && ctx.sourceId) {
      await linear.addComment(
        ctx.sourceId,
        `❌ **Ego — CI failed**\n\n` +
          `Branch: \`${ctx.branch}\`\n` +
          `El CI falló y el retry no lo resolvió.`
      );
    }

    return {
      success: false,
      error: "CI failed after retry",
      turnsUsed: retryResult.turnsUsed,
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

async function retryCIFix(
  ctx: PipelineContext,
  ciLogs: string
): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "ci-retry");

  const prompt = `El CI falló para la branch actual. Tu ÚNICO objetivo es corregir errores de build o lint. NO corrijas lógica de negocio ni tests de lógica.

## Contexto
Branch: ${ctx.branch}
CI logs:
${ciLogs.slice(0, 8000)}

## Instrucciones

1. Analiza los logs de CI. Identifica la causa exacta del fallo.

2. Si es error de build (compilación, imports, tipos):
   - Corrige el error específico
   - Corre typecheck local para verificar

3. Si es error de lint:
   - Corre el linter local
   - Corrige las violaciones

4. Si es error de test de LÓGICA (assertion fail, expected vs received):
   - NO lo corrijas. Reporta que el CI falló por lógica de test y detente.

5. Después de correcciones:
   - Corre typecheck + lint + tests afectados localmente
   - Si pasan, haz commit y push
   - Si no pasan, reporta el fallo y detente

## Output
- Causa del fallo
- Correcciones aplicadas (o motivo por el que no se pudo corregir)
- Status de verificación local`;

  try {
    const result = await runClaude({
      prompt,
      cwd: ctx.worktreePath,
      model: "opus",
      maxTurns: 10,
      timeoutMs: 600_000,
      outputFormat: "json",
      dangerouslySkipPermissions: true,
    });

    return {
      success: result.success,
      output: result.structuredOutput,
      error: result.error,
      turnsUsed: result.turnsUsed,
      durationMs: result.durationMs,
    };
  } catch (err) {
    log.error({ error: (err as Error).message }, "CI retry failed");
    return { success: false, error: (err as Error).message };
  }
}
