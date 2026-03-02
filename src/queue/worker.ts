import { Worker, Job } from "bullmq";
import { getRedisConfig, type TaskJobData } from "./index.js";
import { executePipeline } from "../pipeline/index.js";
import { loadEgoConfig } from "../config.js";
import { shouldCircuitBreak } from "../utils/safety.js";
import { logger } from "../utils/logger.js";

let _worker: Worker | null = null;

export function startWorker(): Worker {
  if (_worker) return _worker;

  const config = loadEgoConfig();

  _worker = new Worker<TaskJobData>(
    "ego-tasks",
    async (job: Job<TaskJobData>) => {
      const { taskId, project } = job.data;
      const log = logger.child({ taskId, project, jobId: job.id });

      // Circuit breaker check
      const { shouldBreak, reason } = shouldCircuitBreak();
      if (shouldBreak) {
        log.error({ reason }, "Circuit breaker OPEN — skipping task");
        throw new Error(reason);
      }

      log.info("Starting pipeline execution");

      try {
        await executePipeline(job.data);
        log.info("Pipeline completed successfully");
      } catch (err) {
        const error = err as Error;
        log.error({ error: error.message }, "Pipeline failed");
        throw err;
      }
    },
    {
      connection: getRedisConfig(),
      concurrency: 1, // One task at a time
      limiter: {
        max: 1,
        duration: config.safety.cooldownSeconds * 1000,
      },
    }
  );

  _worker.on("completed", (job) => {
    logger.info({ taskId: job.data.taskId }, "Job completed");
  });

  _worker.on("failed", (job, err) => {
    logger.error(
      { taskId: job?.data.taskId, error: err.message },
      "Job failed"
    );
  });

  _worker.on("error", (err) => {
    logger.error({ err }, "Worker error");
  });

  logger.info("Worker started — processing tasks");
  return _worker;
}

export async function stopWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
    logger.info("Worker stopped");
  }
}
