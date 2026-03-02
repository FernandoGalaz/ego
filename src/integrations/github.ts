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
    // Wait for the run to appear
    await exec(
      "gh",
      ["run", "list", "--branch", branch, "--limit", "1", "--json", "databaseId,status"],
      { cwd, timeout: 30_000 }
    );

    // Watch the run
    const { stdout, stderr } = await exec(
      "gh",
      ["run", "watch", "--branch", branch, "--exit-status"],
      { cwd, timeout: timeoutMs }
    );

    return { success: true, logs: stdout };
  } catch (error: unknown) {
    const err = error as Error & { stdout?: string; stderr?: string };
    logger.warn({ branch, error: err.message }, "CI failed");

    // Get failure logs
    let logs = err.stdout ?? err.stderr ?? "";
    try {
      const { stdout: failLogs } = await exec(
        "gh",
        ["run", "view", "--branch", branch, "--log-failed"],
        { cwd, timeout: 30_000 }
      );
      logs = failLogs;
    } catch {
      // Can't get logs, use what we have
    }

    return { success: false, logs };
  }
}

export async function getCILogs(branch: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await exec(
      "gh",
      ["run", "view", "--branch", branch, "--log-failed"],
      { cwd, timeout: 30_000 }
    );
    return stdout;
  } catch (error) {
    const err = error as Error & { stdout?: string };
    return err.stdout ?? "Failed to retrieve CI logs";
  }
}
