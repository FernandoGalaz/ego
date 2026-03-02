import { runClaude } from "../integrations/claude.js";
import * as linear from "../integrations/linear.js";
import { phaseLogger } from "../utils/logger.js";
import type { PipelineContext, PhaseResult } from "./index.js";

export async function executeAudit(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "audit");
  const start = Date.now();

  // Fresh session — intentionally no context from dev phase
  const prompt = `Eres un code reviewer senior independiente. Revisa el diff de la branch actual contra main. Tu trabajo es encontrar y CORREGIR problemas.

## Instrucciones

1. Ejecuta: git diff ${ctx.project.baseBranch}...HEAD para ver todos los cambios.

2. Revisa cada archivo modificado buscando:

   **Críticos (bloquean merge):**
   - Vulnerabilidades de seguridad (inyección, XSS, auth bypass)
   - Bugs lógicos que causan comportamiento incorrecto
   - Race conditions
   - Data loss potencial
   - Secrets o credenciales hardcodeadas

   **Importantes (deberían corregirse):**
   - Edge cases no manejados
   - Error handling faltante o inadecuado
   - Tipos incorrectos o any innecesarios
   - Tests que no testean lo que dicen testear
   - Código muerto o comentado

   **Menores (nice to have):**
   - Naming inconsistente con el resto del repo
   - Oportunidades de simplificación
   - Documentación faltante en funciones públicas

3. Para problemas Críticos e Importantes: CORRÍGELOS directamente.
   Para problemas Menores: solo repórtalos.

4. Después de correcciones:
   - Corre typecheck
   - Corre los tests afectados
   - Verifica que tus correcciones no rompieron nada

## Output
Reporta en formato estructurado:
- Total de hallazgos por severidad
- Lista de correcciones aplicadas (archivo + descripción)
- Lista de issues menores reportados (no corregidos)
- Status final de typecheck y tests`;

  try {
    const result = await runClaude({
      prompt,
      cwd: ctx.worktreePath,
      model: "opus",
      maxTurns: 15,
      timeoutMs: 600_000, // 10 min
      outputFormat: "json",
      dangerouslySkipPermissions: true,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Audit failed: ${result.error}`,
        turnsUsed: result.turnsUsed,
        durationMs: Date.now() - start,
      };
    }

    // Linear comment
    if (ctx.source === "linear" && ctx.sourceId) {
      await linear.addComment(
        ctx.sourceId,
        `🔍 **Ego — Auditoría completada**\n\n` +
          `- Turns: ${result.turnsUsed ?? "?"}\n` +
          `- Duración: ${Math.round((Date.now() - start) / 1000)}s`
      );
    }

    log.info({ turns: result.turnsUsed }, "Audit completed");

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
