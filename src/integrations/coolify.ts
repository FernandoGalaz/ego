import { logger } from "../utils/logger.js";
import type { ProjectConfig } from "../config.js";

export async function checkHealth(
  config: ProjectConfig,
  retries: number = 3,
  delayMs: number = 15_000
): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
  if (!config.coolify) {
    logger.info("No Coolify config — skipping health check");
    return { healthy: true };
  }

  const healthUrl = `${config.coolify.devUrl}/health`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        logger.info({ url: healthUrl, attempt }, "Health check passed");
        return { healthy: true, statusCode: res.status };
      }

      logger.warn({ url: healthUrl, status: res.status, attempt }, "Health check failed");
    } catch (err) {
      const error = err as Error;
      logger.warn({ url: healthUrl, error: error.message, attempt }, "Health check error");
    }

    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { healthy: false, error: `Health check failed after ${retries} attempts` };
}

export async function getRecentLogs(
  config: ProjectConfig,
  sinceSeconds: number = 60
): Promise<{ logs: string[]; hasErrors: boolean }> {
  if (!config.coolify?.apiToken) {
    return { logs: [], hasErrors: false };
  }

  try {
    const res = await fetch(
      `${config.coolify.apiUrl}/v1/applications/${config.coolify.appId}/logs?since=${sinceSeconds}`,
      {
        headers: {
          Authorization: `Bearer ${config.coolify.apiToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, "Failed to fetch Coolify logs");
      return { logs: [], hasErrors: false };
    }

    const data = (await res.json()) as string[];
    const errorPatterns = ["fatal", "FATAL", "panic", "PANIC", "unhandled", "ECONNREFUSED"];
    const hasErrors = data.some((line) =>
      errorPatterns.some((p) => line.includes(p))
    );

    return { logs: data, hasErrors };
  } catch (err) {
    const error = err as Error;
    logger.warn({ error: error.message }, "Error fetching Coolify logs");
    return { logs: [], hasErrors: false };
  }
}
