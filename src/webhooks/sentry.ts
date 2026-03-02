import { Hono } from "hono";
import { nanoid } from "nanoid";
import { findProjectBySentryProject, loadEgoConfig } from "../config.js";
import { getDb, schema } from "../db/index.js";
import { enqueueTask } from "../queue/index.js";
import { extractFingerprint } from "../integrations/sentry.js";
import { shouldProcessSentryEvent, markSentryProcessed } from "../utils/safety.js";
import { logger } from "../utils/logger.js";

export const sentryWebhook = new Hono();

interface SentryWebhookPayload {
  action: string;
  data: {
    event?: {
      event_id: string;
      title: string;
      level: string;
      project: string;
      fingerprint?: string[];
    };
    issue?: {
      id: string;
      title: string;
      project: { slug: string };
    };
  };
}

sentryWebhook.post("/", async (c) => {
  const payload = (await c.req.json()) as SentryWebhookPayload;

  // Only process error events
  const event = payload.data.event;
  const issue = payload.data.issue;

  if (!event && !issue) {
    return c.json({ ok: true, skipped: "no event or issue data" });
  }

  const projectSlug =
    event?.project ?? issue?.project?.slug;

  if (!projectSlug) {
    return c.json({ ok: true, skipped: "no project slug" });
  }

  const project = findProjectBySentryProject(projectSlug);
  if (!project) {
    logger.warn({ projectSlug }, "Webhook from unknown Sentry project — discarding");
    return c.json({ ok: false, error: "unknown project" }, 400);
  }

  const fingerprint = extractFingerprint(payload as unknown as Record<string, unknown>);
  const level = event?.level ?? "error";
  const title = event?.title ?? issue?.title ?? "Unknown Sentry event";
  const eventId = event?.event_id ?? issue?.id ?? "unknown";

  // Dedup check
  const { process: shouldProcess, reason, existingTaskId } = shouldProcessSentryEvent(fingerprint);
  if (!shouldProcess) {
    logger.info({ fingerprint, reason, existingTaskId }, "Sentry event deduplicated");
    return c.json({ ok: true, skipped: reason });
  }

  // Store sentry event
  const db = getDb();
  await db.insert(schema.sentryEvents).values({
    fingerprint,
    project: project.name,
    eventId,
    title,
    level,
    receivedAt: new Date().toISOString(),
  });

  // Sentry pause — delay before processing
  const config = loadEgoConfig();
  const pauseMs = config.safety.sentryPauseSeconds * 1000;
  logger.info({ pauseMs, fingerprint }, "Sentry pause — waiting before processing");

  // Schedule the task after the pause
  const priority = level === "fatal" ? 1 : 2; // P1 for fatal, P2 for error
  const taskId = nanoid(12);

  setTimeout(async () => {
    try {
      // Re-check dedup after pause (more events may have arrived)
      const { process: stillProcess } = shouldProcessSentryEvent(fingerprint);
      if (!stillProcess) {
        logger.info({ fingerprint }, "Sentry event deduplicated after pause");
        return;
      }

      await db.insert(schema.tasks).values({
        id: taskId,
        project: project.name,
        source: "sentry",
        sourceId: eventId,
        title: `[Sentry ${level}] ${title}`,
        description: `Fingerprint: ${fingerprint}\nEvent ID: ${eventId}\nLevel: ${level}`,
        priority,
        createdAt: new Date().toISOString(),
      });

      await enqueueTask({
        taskId,
        project: project.name,
        source: "sentry",
        sourceId: eventId,
        title: `[Sentry ${level}] ${title}`,
        description: `Fingerprint: ${fingerprint}\nEvent ID: ${eventId}\nLevel: ${level}`,
        priority,
      });

      markSentryProcessed(fingerprint, taskId);

      logger.info({ taskId, fingerprint, priority }, "Sentry task enqueued after pause");
    } catch (err) {
      logger.error({ err, fingerprint }, "Failed to enqueue sentry task after pause");
    }
  }, pauseMs);

  return c.json({ ok: true, taskId, delayed: true, pauseMs });
});
