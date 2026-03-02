import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadEgoConfig } from "./config.js";
import { initDb } from "./db/index.js";
import { linearWebhook } from "./webhooks/linear.js";
import { sentryWebhook } from "./webhooks/sentry.js";
import { startWorker } from "./queue/worker.js";
import { logger } from "./utils/logger.js";

const app = new Hono();

// Health endpoint
app.get("/health", (c) => c.json({ status: "ok", agent: "ego" }));

// Webhook routes
app.route("/webhooks/linear", linearWebhook);
app.route("/webhooks/sentry", sentryWebhook);

// Status endpoint
app.get("/status", async (c) => {
  // TODO: return queue stats, active tasks, etc.
  return c.json({ status: "running" });
});

export function startServer(): void {
  const config = loadEgoConfig();

  // Initialize database
  initDb();

  // Start worker
  startWorker();

  // Start HTTP server
  serve(
    {
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    },
    (info) => {
      logger.info(
        { port: info.port, host: config.server.host },
        "Ego server started"
      );
      logger.info(
        `  Webhooks: http://${config.server.host}:${info.port}/webhooks/linear`
      );
      logger.info(
        `  Webhooks: http://${config.server.host}:${info.port}/webhooks/sentry`
      );
    }
  );
}

// Allow direct execution
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  startServer();
}
