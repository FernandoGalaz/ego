import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { loadAllProjects, type ProjectConfig } from "./config.js";
import { getDb, schema } from "./db/index.js";
import { enqueueTask } from "./queue/index.js";
import { logger } from "./utils/logger.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  labels: { nodes: Array<{ name: string }> };
}

async function fetchReadyIssues(teamId: string): Promise<LinearIssueNode[]> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return [];

  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `query($teamId: String!) {
        team(id: $teamId) {
          issues(filter: { state: { name: { eq: "Ready for Ego" } } }) {
            nodes { id identifier title description priority labels { nodes { name } } }
          }
        }
      }`,
      variables: { id: teamId },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return [];

  const json = (await res.json()) as {
    data?: { team?: { issues?: { nodes: LinearIssueNode[] } } };
  };

  return json.data?.team?.issues?.nodes ?? [];
}

function isAlreadyEnqueued(db: ReturnType<typeof getDb>, linearIssueId: string): boolean {
  const existing = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.sourceId, linearIssueId))
    .all();

  return existing.some((t) => t.status === "queued" || t.status === "working");
}

export async function syncPendingTasks(): Promise<void> {
  const projects = loadAllProjects();
  let synced = 0;

  for (const [name, config] of projects) {
    const issues = await fetchReadyIssues(config.linear.teamId);

    if (issues.length === 0) {
      logger.debug({ project: name }, "No pending issues in Ready for Ego");
      continue;
    }

    const db = getDb();

    for (const issue of issues) {
      if (isAlreadyEnqueued(db, issue.id)) {
        logger.debug({ identifier: issue.identifier }, "Already enqueued — skipping");
        continue;
      }

      const isFeature = issue.labels.nodes.some(
        (l) => l.name.toLowerCase() === "feature"
      );
      const priority = isFeature ? 4 : 3;
      const taskId = nanoid(12);

      await db.insert(schema.tasks).values({
        id: taskId,
        project: name,
        source: "linear",
        sourceId: issue.id,
        title: issue.title,
        description: issue.description ?? undefined,
        priority,
        createdAt: new Date().toISOString(),
      });

      await enqueueTask({
        taskId,
        project: name,
        source: "linear",
        sourceId: issue.id,
        title: issue.title,
        description: issue.description ?? undefined,
        priority,
      });

      synced++;
      logger.info(
        { taskId, identifier: issue.identifier, project: name },
        "Synced pending issue from Linear"
      );
    }
  }

  if (synced > 0) {
    logger.info({ count: synced }, "Startup sync: enqueued pending tasks");
  } else {
    logger.info("Startup sync: no pending tasks found");
  }
}
