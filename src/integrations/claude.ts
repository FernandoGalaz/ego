import { execFile } from "child_process";
import { logger } from "../utils/logger.js";

export interface ClaudeOptions {
  prompt: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  dangerouslySkipPermissions?: boolean;
  outputFormat?: "json" | "text" | "stream-json";
  jsonSchema?: object;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  allowedTools?: string[];
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  structuredOutput?: unknown;
  sessionId?: string;
  turnsUsed?: number;
  costUsd?: number;
  error?: string;
  durationMs: number;
}

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const startTime = Date.now();
  const args: string[] = ["-p", options.prompt, "--model", options.model ?? "opus"];

  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.outputFormat) {
    args.push("--output-format", options.outputFormat);
  }

  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }

  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }

  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  if (options.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (options.allowedTools?.length) {
    for (const tool of options.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  const timeoutMs = options.timeoutMs ?? 600_000; // 10min default

  logger.debug({ args: args.slice(0, 4), cwd: options.cwd }, "Running claude");

  return new Promise<ClaudeResult>((resolve) => {
    const proc = execFile("claude", args, {
      cwd: options.cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: timeoutMs,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startTime;

      if (error) {
        logger.error({ error: error.message, stderr, durationMs }, "Claude execution failed");
        resolve({
          success: false,
          output: stderr || error.message,
          error: error.message,
          durationMs,
        });
        return;
      }

      // Parse JSON output if requested
      let structuredOutput: unknown = undefined;
      let sessionId: string | undefined;
      let turnsUsed: number | undefined;
      let costUsd: number | undefined;

      if (options.outputFormat === "json") {
        try {
          const parsed = JSON.parse(stdout);
          structuredOutput = parsed.result ?? parsed;
          sessionId = parsed.session_id;
          turnsUsed = parsed.num_turns;
          costUsd = parsed.cost_usd;
        } catch {
          // Output might not be valid JSON, treat as plain text
          logger.warn("Failed to parse claude JSON output, treating as text");
        }
      }

      resolve({
        success: true,
        output: stdout,
        structuredOutput,
        sessionId,
        turnsUsed,
        costUsd,
        durationMs,
      });
    });

    // Log stderr in real-time for debugging
    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) logger.debug({ claude_stderr: line });
    });
  });
}

/**
 * Run a Claude subagent by spawning claude with the agent's own prompt.
 * This doesn't use `.claude/agents/` files — those are used when claude
 * is running interactively. For programmatic use, we pass the prompt directly.
 */
export async function runClaudeWithAgent(
  agentPrompt: string,
  taskPrompt: string,
  cwd: string,
  options?: Partial<ClaudeOptions>
): Promise<ClaudeResult> {
  const fullPrompt = `${agentPrompt}\n\n## Tarea actual\n${taskPrompt}`;
  return runClaude({
    prompt: fullPrompt,
    cwd,
    model: "opus",
    maxTurns: options?.maxTurns ?? 15,
    outputFormat: "json",
    dangerouslySkipPermissions: true,
    ...options,
  });
}
