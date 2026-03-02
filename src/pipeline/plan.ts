import { runClaude, type ClaudeResult } from "../integrations/claude.js";
import * as linear from "../integrations/linear.js";
import { phaseLogger } from "../utils/logger.js";
import { buildLessonsPrompt } from "../utils/lessons.js";
import type { PipelineContext, PhaseResult } from "./index.js";

const PLAN_SCHEMA = {
  type: "object",
  required: ["taskType", "team", "plan"],
  properties: {
    taskType: {
      type: "string",
      enum: ["feature", "bug", "refactor", "schema", "ui"],
    },
    team: { type: "array", items: { type: "string" } },
    plan: {
      type: "object",
      required: ["summary", "files", "tests", "risks", "estimatedComplexity", "verification"],
      properties: {
        summary: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              action: { type: "string", enum: ["create", "modify", "delete"] },
              changes: { type: "string" },
              risks: { type: "array", items: { type: "string" } },
              identifiedBy: { type: "string" },
            },
          },
        },
        tests: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              action: { type: "string", enum: ["create", "modify"] },
              description: { type: "string" },
              type: { type: "string", enum: ["unit", "integration", "e2e"] },
            },
          },
        },
        migrations: { type: "array" },
        risks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              severity: { type: "string", enum: ["high", "medium", "low"] },
              mitigation: { type: "string" },
              identifiedBy: { type: "string" },
            },
          },
        },
        estimatedComplexity: { type: "string", enum: ["low", "medium", "high"] },
        verification: { type: "array", items: { type: "string" } },
      },
    },
  },
};

function selectTeam(taskType: string, description?: string): string[] {
  const desc = (description ?? "").toLowerCase();

  switch (taskType) {
    case "feature":
      if (desc.includes("api") || desc.includes("endpoint")) {
        return ["architect", "security-reviewer", "test-analyst", "performance-analyst"];
      }
      return ["architect", "test-analyst"];

    case "bug":
      if (desc.includes("auth") || desc.includes("permission") || desc.includes("security")) {
        return ["test-analyst", "security-reviewer"];
      }
      return ["test-analyst"];

    case "refactor":
      return ["architect", "test-analyst"];

    case "schema":
      return ["db-analyst", "architect", "test-analyst"];

    case "ui":
      return ["test-analyst"];

    default:
      return ["architect", "test-analyst"];
  }
}

export async function executePlan(ctx: PipelineContext): Promise<PhaseResult> {
  const log = phaseLogger(ctx.taskId, "plan");
  const start = Date.now();

  // Pre-classify to select the right team (heuristic — the plan itself will confirm)
  const heuristicType = classifyTask(ctx.title, ctx.description);
  const team = selectTeam(heuristicType, ctx.description);

  log.info({ heuristicType, team }, "Team selected for planning");

  const prompt = `Eres Ego, un agente autónomo de desarrollo. Tu tarea es generar un plan de implementación detallado. NO escribas ni modifiques código.

## Contexto
- Tarea: ${ctx.title}
- Descripción: ${ctx.description ?? "Sin descripción adicional"}
- Fuente: ${ctx.source}
- Proyecto: ${ctx.projectName}
${ctx.comments ?? ""}

## Instrucciones

1. Lee el CLAUDE.md del proyecto para entender convenciones y stack.

2. Clasifica la tarea:
   - feature | bug | refactor | schema-change | ui-fix

3. Usa subagentes para analizar en paralelo. Equipo: ${team.join(", ")}.
   Cada subagente explora el codebase desde su perspectiva y reporta hallazgos.

4. Consolida los reportes de los subagentes en un plan único.

## Criterios de calidad del plan
- Cada archivo listado DEBE existir o indicar explícitamente que es nuevo
- Cambios por archivo deben ser específicos, no genéricos
- Tests: indicar archivo destino, tipo, y assertions clave
- Riesgos: incluir qué agente lo identificó y severidad
- Incluir pasos de verificación: cómo saber que la implementación es correcta`;

  const lessonsPrompt = buildLessonsPrompt(ctx.project.repo);

  try {
    const result = await runClaude({
      prompt: prompt + lessonsPrompt,
      cwd: ctx.worktreePath,
      model: "opus",
      maxTurns: 15,
      timeoutMs: 600_000, // 10 min
      outputFormat: "json",
      jsonSchema: PLAN_SCHEMA,
      dangerouslySkipPermissions: true,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Plan generation failed: ${result.error}`,
        turnsUsed: result.turnsUsed,
        durationMs: Date.now() - start,
      };
    }

    // Store plan in context
    const planOutput = result.structuredOutput ?? result.output;
    ctx.planJson = typeof planOutput === "string" ? planOutput : JSON.stringify(planOutput);

    // Linear comment
    if (ctx.source === "linear" && ctx.sourceId) {
      const plan = typeof planOutput === "object" ? planOutput as Record<string, unknown> : JSON.parse(ctx.planJson);
      const planObj = plan.plan as Record<string, unknown> | undefined;
      await linear.addComment(
        ctx.sourceId,
        `📋 **Ego — Plan generado**\n\n` +
          `- Tipo: ${plan.taskType}\n` +
          `- Equipo: ${(plan.team as string[]).join(", ")}\n` +
          `- Complejidad: ${planObj?.estimatedComplexity ?? "unknown"}\n` +
          `- Archivos: ${(planObj?.files as unknown[])?.length ?? 0}\n` +
          `- Tests: ${(planObj?.tests as unknown[])?.length ?? 0}\n` +
          `- Resumen: ${planObj?.summary ?? ""}`
      );
    }

    log.info(
      { turns: result.turnsUsed, duration: Date.now() - start },
      "Plan generated successfully"
    );

    return {
      success: true,
      output: planOutput,
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

function classifyTask(title: string, description?: string): string {
  const text = `${title} ${description ?? ""}`.toLowerCase();

  if (text.includes("migrat") || text.includes("schema") || text.includes("table") || text.includes("column")) {
    return "schema";
  }
  if (text.includes("refactor") || text.includes("clean up") || text.includes("reorgani")) {
    return "refactor";
  }
  if (text.includes("bug") || text.includes("fix") || text.includes("error") || text.includes("crash")) {
    return "bug";
  }
  if (text.includes("ui") || text.includes("css") || text.includes("style") || text.includes("layout")) {
    return "ui";
  }
  return "feature";
}
