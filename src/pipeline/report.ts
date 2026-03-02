import * as linear from "../integrations/linear.js";
import * as sentry from "../integrations/sentry.js";
import { runClaude } from "../integrations/claude.js";
import { notify } from "../integrations/notifications.js";
import { cleanupWorktree } from "./worktree.js";
import { phaseLogger } from "../utils/logger.js";
import { readLessons, writeLessons } from "../utils/lessons.js";
import type { PipelineContext, PhaseResult } from "./index.js";

async function extractLessons(ctx: PipelineContext): Promise<void> {
  const log = phaseLogger(ctx.taskId, "lessons");

  const currentLessons = readLessons(ctx.project.repo);

  const prompt = `Analiza el trabajo realizado en esta branch y extrae lecciones aprendidas.

## Contexto
- Tarea: ${ctx.title}
- Proyecto: ${ctx.projectName}
- Branch: ${ctx.branch}
- Turns usados: ${ctx.totalTurns}

## Instrucciones

1. Ejecuta \`git log ${ctx.project.baseBranch}..HEAD --oneline\` para ver los commits.
2. Ejecuta \`git diff ${ctx.project.baseBranch}...HEAD --stat\` para ver archivos modificados.
3. Analiza qué patrones, decisiones y problemas encontraste.

4. Genera un archivo de lecciones aprendidas en formato markdown que REEMPLACE el contenido actual.
   El archivo debe mantener las lecciones anteriores relevantes y agregar las nuevas.

## Lecciones anteriores (mantener las que sigan siendo relevantes)
${currentLessons || "(ninguna — primera ejecución)"}

## Formato de salida
Responde SOLO con el contenido markdown del archivo de lecciones, sin bloques de código.
Usa este formato:

# Ego — Lecciones Aprendidas

## Patrones del proyecto
- Convenciones de código descubiertas
- Estructura de archivos importante
- Dependencias clave

## Problemas comunes
- Errores encontrados y cómo se resolvieron
- Gotchas del stack

## Decisiones técnicas
- Decisiones tomadas y por qué

## Historial de tareas
- [fecha] Tarea: descripción breve — resultado

IMPORTANTE: Máximo 150 líneas. Sé conciso. Prioriza lo útil para futuras ejecuciones.`;

  try {
    const result = await runClaude({
      prompt,
      cwd: ctx.worktreePath,
      model: "haiku",
      maxTurns: 5,
      timeoutMs: 120_000,
      outputFormat: "text",
      dangerouslySkipPermissions: true,
    });

    if (result.success && result.output.trim()) {
      writeLessons(ctx.project.repo, result.output.trim());
      log.info("Lessons extracted and saved");
    } else {
      log.warn("Failed to extract lessons — skipping");
    }
  } catch (err) {
    log.warn({ error: (err as Error).message }, "Lessons extraction failed — non-critical");
  }
}

export async function executeReport(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "report");
  const start = Date.now();

  try {
    // Extract lessons before cleanup (needs worktree)
    await extractLessons(ctx);

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
