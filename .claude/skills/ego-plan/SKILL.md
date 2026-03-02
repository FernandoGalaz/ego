---
name: ego-plan
description: Generate implementation plan for a task using multi-agent analysis
disable-model-invocation: true
---

Genera un plan de implementación para la siguiente tarea: $ARGUMENTS

## Proceso

1. Clasifica la tarea por tipo (feature, bug, refactor, schema-change, ui-fix)
2. Según el tipo, selecciona el equipo de agentes apropiado
3. Delega análisis paralelo a cada agente usando subagents
4. Consolida hallazgos en un plan único

## Selección de equipo por tipo
- Feature nueva con API → architect + security-reviewer + test-analyst + performance-analyst
- Bug de Sentry (crash) → test-analyst + (security-reviewer si toca auth)
- Refactor de módulo → architect + test-analyst
- Cambio de schema → db-analyst + architect + test-analyst
- Fix de UI → test-analyst

## Output requerido (JSON)
```json
{
  "taskType": "feature|bug|refactor|schema|ui",
  "team": ["agents utilizados"],
  "plan": {
    "summary": "resumen de 1-2 líneas",
    "files": [
      {
        "path": "src/...",
        "action": "create|modify|delete",
        "changes": "descripción de cambios",
        "risks": ["riesgos identificados"],
        "identifiedBy": "agente que lo identificó"
      }
    ],
    "tests": [
      {
        "file": "src/...test.ts",
        "action": "create|modify",
        "description": "qué testea",
        "type": "unit|integration|e2e"
      }
    ],
    "migrations": [],
    "risks": [
      {
        "description": "...",
        "severity": "high|medium|low",
        "mitigation": "...",
        "identifiedBy": "agente"
      }
    ],
    "estimatedComplexity": "low|medium|high",
    "verification": ["cómo verificar que el plan se implementó correctamente"]
  }
}
```
