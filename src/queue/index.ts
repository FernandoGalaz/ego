import { Queue, type ConnectionOptions } from "bullmq";
import { loadEgoConfig } from "../config.js";
import { logger } from "../utils/logger.js";

export interface TaskJobData {
  taskId: string;
  project: string;
  source: "linear" | "sentry" | "cli";
  sourceId?: string;
  title: string;
  description?: string;
  priority: number; // 0-4, lower = higher priority
  resumeFromPhase?: string; // Phase name to resume from (retry)
}

let _queue: Queue<TaskJobData> | null = null;

export function getRedisConfig(): ConnectionOptions {
  const config = loadEgoConfig();
  return {
    host: config.redis.host,
    port: config.redis.port,
  };
}

export function getQueue(): Queue<TaskJobData> {
  if (_queue) return _queue;

  _queue = new Queue<TaskJobData>("ego-tasks", {
    connection: getRedisConfig(),
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
      attempts: 1, // No retries — Ego handles retries at pipeline level
    },
  });

  logger.info("Task queue initialized");
  return _queue;
}

export async function enqueueTask(data: TaskJobData): Promise<string> {
  const queue = getQueue();

  const job = await queue.add(`task-${data.taskId}`, data, {
    priority: data.priority,
    jobId: data.taskId,
  });

  logger.info(
    { taskId: data.taskId, priority: data.priority, source: data.source },
    "Task enqueued"
  );

  return job.id!;
}

export async function closeQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}
