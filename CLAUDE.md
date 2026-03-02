# Ego — Autonomous Coding Agent

## Build & Run
- `npx tsx src/index.ts start` para iniciar server + worker
- `npx tsx src/index.ts task -p <project> "description"` para task manual
- `npx tsx src/index.ts status` para ver estado

## Stack
- TypeScript + Hono (webhooks HTTP)
- BullMQ + Redis (cola de tareas)
- SQLite + Drizzle (persistencia)
- Claude Code CLI (ejecución de agente)

## Convenciones
- ES modules (import/export), nunca CommonJS
- Zod para validación de inputs
- Pino para logging estructurado
- Archivos terminan en .ts, nunca .js en source

## Testing
- `bun test` para correr tests (vitest)
- `npx tsc --noEmit` para typecheck

## Arquitectura
- src/pipeline/ — las 8 fases del pipeline
- src/integrations/ — wrappers de APIs externas (Linear, Sentry, GitHub, Coolify)
- src/webhooks/ — handlers de webhooks
- src/queue/ — BullMQ queue + worker
- src/db/ — SQLite schema + init
- src/utils/ — logger, lock, safety

## Decisiones
- 1 tarea a la vez (concurrency: 1)
- Git worktrees para aislamiento
- Claude Code CLI con `--model opus` siempre
- No merge a main nunca — solo branches para review
