import { runClaude } from "../integrations/claude.js";
import * as linear from "../integrations/linear.js";
import { phaseLogger } from "../utils/logger.js";
import { buildLessonsPrompt } from "../utils/lessons.js";
import type { PipelineContext, PhaseResult } from "./index.js";

export async function executeDev(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "dev");
  const start = Date.now();

  if (!ctx.planJson) {
    return { success: false, error: "No plan available for development", durationMs: 0 };
  }

  const prompt = `Eres Ego, un agente autónomo de desarrollo. Implementa exactamente el plan proporcionado. NO hagas más de lo que dice el plan.

## Plan a implementar
${ctx.planJson}
${ctx.comments ?? ""}

## Instrucciones

1. Lee el CLAUDE.md del proyecto para recordar convenciones y comandos.

2. Implementa los cambios archivo por archivo, siguiendo el orden del plan.
   - Commits atómicos: un commit por cambio lógico cohesivo.
   - Mensajes de commit descriptivos en inglés: 'feat:', 'fix:', 'refactor:', 'test:'.

3. Después de cada archivo modificado, verifica:
   - Typecheck pasa: ejecuta el comando de typecheck del CLAUDE.md
   - Linter pasa: ejecuta el comando de lint del CLAUDE.md

4. Cuando todos los cambios estén hechos:
   - Corre los tests relevantes (NO toda la suite, solo los afectados)
   - Si un test falla, corrígelo y vuelve a correr
   - Si después de 2 intentos sigue fallando, documenta el fallo y continúa

5. NO hagas cambios que no estén en el plan.
   NO refactorices código que no sea parte de la tarea.
   NO actualices dependencias salvo que el plan lo indique.

## Verificación final
Antes de terminar, ejecuta:
- Typecheck completo
- Linter completo
- Tests afectados

Reporta: archivos modificados, commits creados, tests ejecutados (pass/fail), cualquier desviación del plan.`;

  const lessonsPrompt = buildLessonsPrompt(ctx.project.repo);

  try {
    const result = await runClaude({
      prompt: prompt + lessonsPrompt,
      cwd: ctx.worktreePath,
      model: "opus",
      maxTurns: 50,
      timeoutMs: 1_800_000, // 30 min
      outputFormat: "json",
      dangerouslySkipPermissions: true,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Development failed: ${result.error}`,
        turnsUsed: result.turnsUsed,
        durationMs: Date.now() - start,
      };
    }

    // Linear comment
    if (ctx.source === "linear" && ctx.sourceId) {
      await linear.addComment(
        ctx.sourceId,
        `🔨 **Ego — Desarrollo completado**\n\n` +
          `- Turns: ${result.turnsUsed ?? "?"}\n` +
          `- Duración: ${Math.round((Date.now() - start) / 1000)}s\n` +
          `- Branch: \`${ctx.branch}\``
      );
    }

    log.info({ turns: result.turnsUsed }, "Development completed");

    return {
      success: true,
      output: result.structuredOutput ?? result.output,
      turnsUsed: result.turnsUsed,
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
