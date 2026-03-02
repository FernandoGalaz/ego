import { logger } from "../utils/logger.js";

// Linear API wrapper — uses REST API for simplicity
// Linear API key should be in LINEAR_API_KEY env var

const LINEAR_API_URL = "https://api.linear.app/graphql";

function getApiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY environment variable is required");
  return key;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getApiKey(),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { data: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  return json.data;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: { name: string };
  team: { id: string; key: string };
  labels: { nodes: Array<{ name: string }> };
}

export async function getIssue(issueId: string): Promise<LinearIssue> {
  const data = await gql<{ issue: LinearIssue }>(
    `query($id: String!) {
      issue(id: $id) {
        id identifier title description priority
        state { name }
        team { id key }
        labels { nodes { name } }
      }
    }`,
    { id: issueId }
  );
  return data.issue;
}

export async function updateIssueState(issueId: string, stateName: string): Promise<void> {
  // First find the state ID by name for the issue's team
  const issue = await getIssue(issueId);
  const teamId = issue.team.id;

  const statesData = await gql<{
    workflowStates: { nodes: Array<{ id: string; name: string }> };
  }>(
    `query($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name }
      }
    }`,
    { teamId }
  );

  const state = statesData.workflowStates.nodes.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase()
  );
  if (!state) {
    logger.warn({ stateName, teamId }, "Linear state not found");
    return;
  }

  await gql(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }`,
    { id: issueId, stateId: state.id }
  );

  logger.info({ issueId, stateName }, "Linear issue state updated");
}

export async function addComment(issueId: string, body: string): Promise<void> {
  await gql(
    `mutation($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body }) {
        success
      }
    }`,
    { id: issueId, body }
  );
  logger.debug({ issueId }, "Linear comment added");
}

export interface LinearComment {
  body: string;
  user: { name: string } | null;
  createdAt: string;
}

export async function getComments(issueId: string): Promise<LinearComment[]> {
  const data = await gql<{
    issue: { comments: { nodes: LinearComment[] } };
  }>(
    `query($id: String!) {
      issue(id: $id) {
        comments(orderBy: createdAt) {
          nodes { body user { name } createdAt }
        }
      }
    }`,
    { id: issueId }
  );
  return data.issue.comments.nodes;
}

export function formatCommentsForPrompt(comments: LinearComment[]): string {
  if (comments.length === 0) return "";

  // Filter out Ego's own comments
  const userComments = comments.filter(
    (c) => !c.body.startsWith("🤖") && !c.body.startsWith("📊") &&
           !c.body.startsWith("📋") && !c.body.startsWith("🔨") &&
           !c.body.startsWith("🔍") && !c.body.startsWith("✅") &&
           !c.body.startsWith("❌") && !c.body.startsWith("🏥")
  );

  if (userComments.length === 0) return "";

  const formatted = userComments.map((c) => {
    const author = c.user?.name ?? "Unknown";
    const date = c.createdAt.split("T")[0];
    return `- **${author}** (${date}): ${c.body}`;
  }).join("\n");

  return `\n## Comentarios del equipo\n${formatted}`;
}

export async function assignIssue(issueId: string, userId: string): Promise<void> {
  await gql(
    `mutation($id: String!, $assigneeId: String!) {
      issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
        success
      }
    }`,
    { id: issueId, assigneeId: userId }
  );
}

export function mapPriority(linearPriority: number): number {
  // Linear: 0=none, 1=urgent, 2=high, 3=medium, 4=low
  // Ego: P0=manual, P1=sentry-fatal, P2=sentry-error, P3=linear-bug, P4=linear-feature
  // For Linear issues, map based on labels/type rather than priority directly
  return 3; // Default P3 for Linear issues
}
