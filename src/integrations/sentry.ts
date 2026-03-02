import { logger } from "../utils/logger.js";

// Sentry REST API wrapper
// SENTRY_AUTH_TOKEN env var required

const SENTRY_API_URL = "https://sentry.io/api/0";

function getAuthToken(): string {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error("SENTRY_AUTH_TOKEN environment variable is required");
  return token;
}

async function sentryFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${SENTRY_API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Sentry API error ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<T>;
}

export interface SentryIssueData {
  id: string;
  title: string;
  culprit: string;
  level: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  metadata: { type?: string; value?: string; filename?: string; function?: string };
  shortId: string;
  project: { slug: string };
}

export async function getIssue(org: string, issueId: string): Promise<SentryIssueData> {
  return sentryFetch(`/organizations/${org}/issues/${issueId}/`);
}

export async function getLatestEvent(
  org: string,
  issueId: string
): Promise<{ eventID: string; context?: unknown; tags: Array<{ key: string; value: string }>; entries: unknown[] }> {
  return sentryFetch(`/organizations/${org}/issues/${issueId}/events/latest/`);
}

export async function addComment(org: string, issueId: string, text: string): Promise<void> {
  const res = await fetch(`${SENTRY_API_URL}/organizations/${org}/issues/${issueId}/comments/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    logger.warn({ issueId, status: res.status }, "Failed to add Sentry comment");
  }
}

export function extractFingerprint(
  webhookPayload: Record<string, unknown>
): string {
  // Sentry webhook fingerprint extraction
  const data = webhookPayload.data as Record<string, unknown> | undefined;
  const event = (data?.event as Record<string, unknown>) ?? data;

  if (event?.fingerprint && Array.isArray(event.fingerprint)) {
    return (event.fingerprint as string[]).join("|");
  }

  // Fallback: use issue ID
  const issueId = (event?.issue_id as string) ?? (data?.id as string) ?? "unknown";
  return `sentry-${issueId}`;
}
