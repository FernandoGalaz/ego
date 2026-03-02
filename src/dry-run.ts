import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import Redis from "ioredis";
import { loadProject, loadEgoConfig, type ProjectConfig } from "./config.js";
import { initDb, getDb, closeDb } from "./db/index.js";

const exec = promisify(execFile);

type CheckStatus = "pass" | "fail" | "skip";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

async function checkProjectConfig(projectName: string): Promise<CheckResult> {
  try {
    const config = loadProject(projectName);
    return { name: "Project config", status: "pass", detail: `loaded OK (${config.name})` };
  } catch (err) {
    return { name: "Project config", status: "fail", detail: (err as Error).message };
  }
}

async function checkSqlite(): Promise<CheckResult> {
  try {
    initDb();
    const db = getDb();
    const { schema } = await import("./db/index.js");
    await db.select().from(schema.tasks).limit(1);
    return { name: "SQLite", status: "pass", detail: "connected" };
  } catch (err) {
    return { name: "SQLite", status: "fail", detail: (err as Error).message };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const config = loadEgoConfig();
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 5000,
    lazyConnect: true,
  });
  redis.on("error", () => {});

  try {
    await redis.connect();
    const pong = await redis.ping();
    await redis.quit();
    return { name: "Redis", status: "pass", detail: `${config.redis.host}:${config.redis.port} (${pong})` };
  } catch (err) {
    try { await redis.quit(); } catch {}
    const msg = (err as Error).message;
    return {
      name: "Redis",
      status: "fail",
      detail: `${msg}\n                          Hint: brew install redis && brew services start redis`,
    };
  }
}

async function checkGitRepo(config: ProjectConfig): Promise<CheckResult> {
  try {
    if (!existsSync(config.repo)) {
      return { name: "Git repo", status: "fail", detail: `path not found: ${config.repo}` };
    }
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd: config.repo });
    return { name: "Git repo", status: "pass", detail: config.repo };
  } catch (err) {
    return { name: "Git repo", status: "fail", detail: (err as Error).message };
  }
}

async function checkGithubCli(config: ProjectConfig): Promise<CheckResult> {
  try {
    const { stdout: authOut } = await exec("gh", ["auth", "status"], { timeout: 10_000 });
    // Extract username from auth status (stderr or stdout depending on version)
    let user = "authenticated";
    const match = authOut.match(/Logged in to .+ as (\S+)/);
    if (match) user = `authenticated as ${match[1]}`;

    await exec("gh", ["repo", "view", config.github.repo, "--json", "name"], { timeout: 10_000 });
    return { name: "GitHub CLI", status: "pass", detail: user };
  } catch (err) {
    const msg = (err as Error).message;
    // gh auth status writes to stderr on success in some versions
    if (msg.includes("stderr")) {
      try {
        await exec("gh", ["repo", "view", config.github.repo, "--json", "name"], { timeout: 10_000 });
        return { name: "GitHub CLI", status: "pass", detail: "authenticated" };
      } catch {}
    }
    return { name: "GitHub CLI", status: "fail", detail: msg };
  }
}

async function checkClaudeCli(): Promise<CheckResult> {
  try {
    const { stdout } = await exec("claude", ["--version"], { timeout: 10_000 });
    return { name: "Claude CLI", status: "pass", detail: stdout.trim() };
  } catch (err) {
    return { name: "Claude CLI", status: "fail", detail: (err as Error).message };
  }
}

async function checkLinearApi(config: ProjectConfig): Promise<CheckResult> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return { name: "Linear API", status: "fail", detail: "LINEAR_API_KEY not set" };
  }

  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: `query($id: String!) { team(id: $id) { id name key } }`,
        variables: { id: config.linear.teamId },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { name: "Linear API", status: "fail", detail: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as {
      data?: { team?: { name: string; key: string } };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      return { name: "Linear API", status: "fail", detail: json.errors[0].message };
    }

    const team = json.data?.team;
    if (!team) {
      return { name: "Linear API", status: "fail", detail: `team ${config.linear.teamId} not found` };
    }

    return { name: "Linear API", status: "pass", detail: `team ${team.name} (${team.key})` };
  } catch (err) {
    return { name: "Linear API", status: "fail", detail: (err as Error).message };
  }
}

async function checkSentryApi(config: ProjectConfig): Promise<CheckResult> {
  if (!config.sentry) {
    return { name: "Sentry API", status: "skip", detail: "no sentry config" };
  }

  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) {
    return { name: "Sentry API", status: "skip", detail: "no SENTRY_AUTH_TOKEN" };
  }

  try {
    const res = await fetch(
      `https://sentry.io/api/0/projects/${config.sentry.org}/${config.sentry.project}/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      return { name: "Sentry API", status: "fail", detail: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as { slug: string };
    return { name: "Sentry API", status: "pass", detail: `${config.sentry.org}/${data.slug}` };
  } catch (err) {
    return { name: "Sentry API", status: "fail", detail: (err as Error).message };
  }
}

async function checkCoolify(config: ProjectConfig): Promise<CheckResult> {
  if (!config.coolify) {
    return { name: "Coolify", status: "skip", detail: "no coolify config" };
  }

  if (!config.coolify.apiToken) {
    return { name: "Coolify", status: "skip", detail: "no apiToken" };
  }

  try {
    const res = await fetch(`${config.coolify.apiUrl}/v1/healthcheck`, {
      headers: { Authorization: `Bearer ${config.coolify.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      return { name: "Coolify", status: "pass", detail: config.coolify.apiUrl };
    }
    return { name: "Coolify", status: "fail", detail: `HTTP ${res.status}` };
  } catch (err) {
    return { name: "Coolify", status: "fail", detail: (err as Error).message };
  }
}

function formatResult(result: CheckResult): string {
  const icon =
    result.status === "pass" ? "\x1b[32m✅\x1b[0m" :
    result.status === "fail" ? "\x1b[31m❌\x1b[0m" :
    "\x1b[33m⏭️\x1b[0m";

  const name = result.name.padEnd(18);
  return `  ${icon} ${name} ${result.detail}`;
}

export async function executeDryRun(projectName: string): Promise<void> {
  console.log(`\n  Ego Dry Run — Project: ${projectName}`);
  console.log("  " + "─".repeat(50));

  // 1. Project config (must pass to continue with project-specific checks)
  const configResult = await checkProjectConfig(projectName);
  console.log(formatResult(configResult));

  let config: ProjectConfig | null = null;
  if (configResult.status === "pass") {
    config = loadProject(projectName);
  }

  // 2. SQLite
  const sqliteResult = await checkSqlite();
  console.log(formatResult(sqliteResult));

  // 3. Redis
  const redisResult = await checkRedis();
  console.log(formatResult(redisResult));

  // Remaining checks need a valid project config
  const results: CheckResult[] = [configResult, sqliteResult, redisResult];

  if (config) {
    // 4. Git repo
    const gitResult = await checkGitRepo(config);
    console.log(formatResult(gitResult));
    results.push(gitResult);

    // 5. GitHub CLI
    const ghResult = await checkGithubCli(config);
    console.log(formatResult(ghResult));
    results.push(ghResult);

    // 6. Claude CLI
    const claudeResult = await checkClaudeCli();
    console.log(formatResult(claudeResult));
    results.push(claudeResult);

    // 7. Linear API
    const linearResult = await checkLinearApi(config);
    console.log(formatResult(linearResult));
    results.push(linearResult);

    // 8. Sentry API
    const sentryResult = await checkSentryApi(config);
    console.log(formatResult(sentryResult));
    results.push(sentryResult);

    // 9. Coolify
    const coolifyResult = await checkCoolify(config);
    console.log(formatResult(coolifyResult));
    results.push(coolifyResult);
  }

  console.log("  " + "─".repeat(50));

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const total = results.length;

  const summaryColor = failed > 0 ? "\x1b[31m" : "\x1b[32m";
  console.log(
    `  ${summaryColor}Result: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped\x1b[0m`
  );
  console.log();

  // Cleanup
  try { await closeDb(); } catch {}

  if (failed > 0) {
    process.exit(1);
  }
}
