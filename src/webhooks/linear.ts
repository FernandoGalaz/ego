import { Hono } from "hono";
import { nanoid } from "nanoid";
import { findProjectByLinearTeam } from "../config.js";
import { getDb, schema } from "../db/index.js";
import { enqueueTask } from "../queue/index.js";
import { logger } from "../utils/logger.js";

export const linearWebhook = new Hono();

interface LinearWebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    title: string;
    description?: string;
    priority: number;
    state: { name: string };
    team: { id: string; key: string };
    labels: Array<{ name: string }>;
  };
  updatedFrom?: {
    stateId?: string;
  };
}

linearWebhook.post("/", async (c) => {
  const payload = (await c.req.json()) as LinearWebhookPayload;

  // Only process issue state changes
  if (payload.type !== "Issue" || payload.action !== "update") {
    return c.json({ ok: true, skipped: "not a state change" });
  }

  // Only process if the state changed to "Ready for Ego"
  if (payload.data.state.name !== "Ready for Ego") {
    return c.json({ ok: true, skipped: "not Ready for Ego" });
  }

  // Ensure state actually changed (not just any update while in that state)
  if (!payload.updatedFrom?.stateId) {
    return c.json({ ok: true, skipped: "no state change detected" });
  }

  const teamId = payload.data.team.id;
  const project = findProjectByLinearTeam(teamId);

  if (!project) {
    logger.warn({ teamId }, "Webhook from unknown Linear team — discarding");
    return c.json({ ok: false, error: "unknown team" }, 400);
  }

  const isFeature = payload.data.labels.some(
    (l) => l.name.toLowerCase() === "feature"
  );
  const priority = isFeature ? 4 : 3; // P4 for features, P3 for bugs/tasks

  const taskId = nanoid(12);
  const db = getDb();

  await db.insert(schema.tasks).values({
    id: taskId,
    project: project.name,
    source: "linear",
    sourceId: payload.data.id,
    title: payload.data.title,
    description: payload.data.description ?? undefined,
    priority,
    createdAt: new Date().toISOString(),
  });

  await enqueueTask({
    taskId,
    project: project.name,
    source: "linear",
    sourceId: payload.data.id,
    title: payload.data.title,
    description: payload.data.description ?? undefined,
    priority,
  });

  logger.info(
    { taskId, linearId: payload.data.id, project: project.name, priority },
    "Linear task enqueued"
  );

  return c.json({ ok: true, taskId });
});
