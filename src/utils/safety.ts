import { loadEgoConfig } from "../config.js";
import { logger } from "./logger.js";

interface FailureRecord {
  timestamp: number;
  taskId: string;
  phase: string;
  file?: string;
}

const failures: FailureRecord[] = [];
const fileFailures: Map<string, number> = new Map();

export function recordFailure(taskId: string, phase: string, file?: string): void {
  failures.push({ timestamp: Date.now(), taskId, phase, file });

  if (file) {
    const count = (fileFailures.get(file) ?? 0) + 1;
    fileFailures.set(file, count);
  }

  // Prune old failures (keep last hour)
  const oneHourAgo = Date.now() - 3600_000;
  while (failures.length > 0 && failures[0].timestamp < oneHourAgo) {
    failures.shift();
  }
}

export function shouldCircuitBreak(): { shouldBreak: boolean; reason?: string } {
  const config = loadEgoConfig();
  const maxPerHour = config.safety.maxFailuresPerHour;

  if (failures.length >= maxPerHour) {
    return {
      shouldBreak: true,
      reason: `Circuit breaker: ${failures.length} failures in the last hour (max: ${maxPerHour})`,
    };
  }

  return { shouldBreak: false };
}

export function shouldSkipFile(filePath: string): boolean {
  const config = loadEgoConfig();
  const count = fileFailures.get(filePath) ?? 0;
  return count >= config.safety.maxFailuresPerFile;
}

export function isProtectedPath(filePath: string): boolean {
  const protectedPatterns = [".env", ".pem", ".key", ".secret", "credentials", ".p12", ".pfx"];
  return protectedPatterns.some((p) => filePath.includes(p));
}

export function resetFailures(): void {
  failures.length = 0;
  fileFailures.clear();
  logger.info("Safety counters reset");
}

// Sentry dedup
const sentryFingerprints: Map<string, { count: number; lastSeen: number; taskId?: string }> =
  new Map();

export function shouldProcessSentryEvent(fingerprint: string): {
  process: boolean;
  reason?: string;
  existingTaskId?: string;
} {
  const existing = sentryFingerprints.get(fingerprint);

  if (existing?.taskId) {
    return {
      process: false,
      reason: `Duplicate fingerprint — already processed as task ${existing.taskId}`,
      existingTaskId: existing.taskId,
    };
  }

  if (existing) {
    existing.count++;
    existing.lastSeen = Date.now();
  } else {
    sentryFingerprints.set(fingerprint, { count: 1, lastSeen: Date.now() });
  }

  return { process: true };
}

export function markSentryProcessed(fingerprint: string, taskId: string): void {
  const existing = sentryFingerprints.get(fingerprint);
  if (existing) {
    existing.taskId = taskId;
  } else {
    sentryFingerprints.set(fingerprint, { count: 1, lastSeen: Date.now(), taskId });
  }
}
