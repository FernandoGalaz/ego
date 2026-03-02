import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger.js";

const exec = promisify(execFile);

/**
 * All GitHub operations go through `gh` CLI.
 * This avoids managing tokens — `gh` handles auth.
 */

export async function pushBranch(branch: string, cwd: string): Promise<void> {
  await exec("git", ["push", "-u", "origin", branch], { cwd });
  logger.info({ branch }, "Branch pushed to origin");
}

export async function createPR(
  options: {
    title: string;
    body: string;
    branch: string;
    base?: string;
    draft?: boolean;
  },
  cwd: string
): Promise<string> {
  const args = [
    "pr",
    "create",
    "--title",
    options.title,
    "--body",
    options.body,
    "--head",
    options.branch,
  ];

  if (options.base) args.push("--base", options.base);
  if (options.draft) args.push("--draft");

  const { stdout } = await exec("gh", args, { cwd });
  const prUrl = stdout.trim();
  logger.info({ prUrl, branch: options.branch }, "PR created");
  return prUrl;
}

export async function waitForCI(
  branch: string,
  cwd: string,
  timeoutMs: number = 600_000
): Promise<{ success: boolean; logs?: string }> {
  try {
    // Wait for the workflow run to appear (poll up to 60s)
    let runId: string | null = null;
    const pollStart = Date.now();

    while (!runId && Date.now() - pollStart < 60_000) {
      const { stdout } = await exec(
        "gh",
        ["run", "list", "--branch", branch, "--limit", "1", "--json", "databaseId,status"],
        { cwd, timeout: 30_000 }
      );

      const runs = JSON.parse(stdout) as Array<{ databaseId: number; status: string }>;
      if (runs.length > 0) {
        runId = String(runs[0].databaseId);
        break;
      }

      // Wait 5s before retrying
      await new Promise((r) => setTimeout(r, 5_000));
    }

    if (!runId) {
      return { success: false, logs: "No CI run found for branch" };
    }

    logger.info({ branch, runId }, "Found CI run — watching");

    // Watch the specific run by ID
    const { stdout } = await exec(
      "gh",
      ["run", "watch", runId, "--exit-status"],
      { cwd, timeout: timeoutMs }
    );

    return { success: true, logs: stdout };
  } catch (error: unknown) {
    const err = error as Error & { stdout?: string; stderr?: string };
    logger.warn({ branch, error: err.message }, "CI failed");

    // Try to get the run ID for failure logs
    let logs = err.stdout ?? err.stderr ?? "";
    try {
      const { stdout: listOut } = await exec(
        "gh",
        ["run", "list", "--branch", branch, "--limit", "1", "--json", "databaseId"],
        { cwd, timeout: 30_000 }
      );
      const runs = JSON.parse(listOut) as Array<{ databaseId: number }>;
      if (runs.length > 0) {
        const { stdout: failLogs } = await exec(
          "gh",
          ["run", "view", String(runs[0].databaseId), "--log-failed"],
          { cwd, timeout: 30_000 }
        );
        logs = failLogs;
      }
    } catch {
      // Can't get logs, use what we have
    }

    return { success: false, logs };
  }
}

export async function mergePR(
  prUrl: string,
  cwd: string,
  method: "merge" | "squash" | "rebase" = "squash"
): Promise<void> {
  await exec("gh", ["pr", "merge", prUrl, `--${method}`, "--delete-branch"], {
    cwd,
    timeout: 60_000,
  });
  logger.info({ prUrl, method }, "PR merged");
}

export async function getCILogs(branch: string, cwd: string): Promise<string> {
  try {
    // Get the latest run ID for this branch
    const { stdout: listOut } = await exec(
      "gh",
      ["run", "list", "--branch", branch, "--limit", "1", "--json", "databaseId"],
      { cwd, timeout: 30_000 }
    );
    const runs = JSON.parse(listOut) as Array<{ databaseId: number }>;
    if (runs.length === 0) return "No CI runs found for branch";

    const { stdout } = await exec(
      "gh",
      ["run", "view", String(runs[0].databaseId), "--log-failed"],
      { cwd, timeout: 30_000 }
    );
    return stdout;
  } catch (error) {
    const err = error as Error & { stdout?: string };
    return err.stdout ?? "Failed to retrieve CI logs";
  }
}
