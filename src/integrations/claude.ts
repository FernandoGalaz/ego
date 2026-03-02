import { spawn } from "child_process";
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

  // Always use stream-json for real-time visibility (requires --verbose with -p)
  args.push("--output-format", "stream-json", "--verbose");

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

  const timeoutMs = options.timeoutMs ?? 600_000;

  logger.info(
    { model: options.model ?? "opus", maxTurns: options.maxTurns, timeout: `${timeoutMs / 1000}s`, cwd: options.cwd },
    "Starting Claude execution"
  );

  return new Promise<ClaudeResult>((resolve) => {
    let resolved = false;
    let stdoutBuffer = "";
    let resultEvent: Record<string, unknown> | null = null;
    let structuredJsonOutput: unknown = null;
    let turnCount = 0;

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info({ elapsed: `${elapsed}s`, model: options.model ?? "opus", turns: turnCount }, "Claude still working...");
    }, 30_000);

    // Strip CLAUDECODE env var to prevent nested session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn("claude", args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Parse NDJSON stream from stdout — real-time visibility
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();

      // Process complete lines
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          processStreamEvent(event);
        } catch {
          logger.debug({ raw: trimmed.slice(0, 200) }, "Claude raw output");
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        logger.debug({ claude_stderr: line });
      }
    });

    function processStreamEvent(event: Record<string, unknown>): void {
      switch (event.type) {
        case "system":
          logger.info(
            { subtype: event.subtype, session: (event as Record<string, unknown>).session_id },
            "Claude session initialized"
          );
          break;

        case "assistant": {
          const message = event.message as Record<string, unknown> | undefined;
          const content = (message?.content ?? []) as Array<Record<string, unknown>>;

          for (const block of content) {
            if (block.type === "tool_use") {
              const inputStr = JSON.stringify(block.input ?? {});
              logger.info(
                { tool: block.name, input: inputStr.slice(0, 150) },
                `Claude → ${block.name}`
              );

              // Capture StructuredOutput — this is the JSON schema result
              if (block.name === "StructuredOutput" && block.input) {
                structuredJsonOutput = block.input;
              }
            }
            if (block.type === "text") {
              const text = (block.text as string) ?? "";
              if (text.length > 0) {
                logger.debug({ text: text.slice(0, 200) }, "Claude thinking");
              }
            }
          }

          // Count turns — use stop_reason if available, otherwise count
          // assistant messages with tool_use content as turns
          const stopReason = message?.stop_reason ?? (event as Record<string, unknown>).stop_reason;
          if (stopReason === "end_turn" || stopReason === "tool_use") {
            turnCount++;
          } else if (content.some((b) => b.type === "tool_use")) {
            // Fallback: count any assistant message with tool calls as a turn
            turnCount++;
          }
          break;
        }

        case "result":
          resultEvent = event;
          logger.info(
            {
              subtype: event.subtype,
              turns: event.num_turns,
              cost: event.cost_usd,
              duration: event.duration_ms,
            },
            "Claude execution result"
          );
          break;
      }
    }

    // Timeout handling — SIGTERM then SIGKILL
    const timer = setTimeout(() => {
      if (!resolved) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        logger.error(
          { elapsed: `${elapsed}s`, turns: turnCount },
          "Claude timed out — killing process"
        );
        proc.kill("SIGTERM");
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        }, 5000);
      }
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (!resolved) {
        resolved = true;
        logger.error({ error: err.message }, "Claude process error");
        resolve({
          success: false,
          output: err.message,
          error: err.message,
          durationMs: Date.now() - startTime,
        });
      }
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (resolved) return;
      resolved = true;
      const durationMs = Date.now() - startTime;

      // Process any remaining buffer
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim()) as Record<string, unknown>;
          processStreamEvent(event);
        } catch { /* ignore */ }
      }

      // Killed by signal (timeout or external)
      if (signal) {
        resolve({
          success: false,
          output: `Killed by signal: ${signal}`,
          error: `Claude killed by ${signal} after ${Math.round(durationMs / 1000)}s`,
          durationMs,
        });
        return;
      }

      // Non-zero exit without result
      if (code !== 0 && !resultEvent) {
        resolve({
          success: false,
          output: `Process exited with code ${code}`,
          error: `Claude exited with code ${code}`,
          durationMs,
        });
        return;
      }

      // Extract result from stream
      let output = "";
      let structuredOutput: unknown = undefined;
      let sessionId: string | undefined;
      let turnsUsed: number | undefined;
      let costUsd: number | undefined;

      if (resultEvent) {
        const rawResult = resultEvent.result;
        output = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
        // Prefer StructuredOutput tool capture over result text
        structuredOutput = structuredJsonOutput ?? rawResult;
        sessionId = resultEvent.session_id as string | undefined;
        turnsUsed = resultEvent.num_turns as number | undefined;
        costUsd = resultEvent.cost_usd as number | undefined;
      }

      const isError = resultEvent?.subtype === "error_max_turns" ||
                      resultEvent?.is_error === true;

      logger.info(
        { durationMs, turns: turnsUsed, cost: costUsd, subtype: resultEvent?.subtype },
        "Claude execution finished"
      );

      resolve({
        success: !isError,
        output,
        structuredOutput,
        sessionId,
        turnsUsed,
        costUsd,
        durationMs,
        ...(isError ? { error: `Claude ended with: ${resultEvent?.subtype}` } : {}),
      });
    });
  });
}

/**
 * Run Claude with automatic session resume on max_turns.
 * When Claude hits the turn limit, resumes the same session up to maxResumes times.
 * Returns aggregated turns across all attempts.
 */
export async function runClaudeWithResume(
  options: ClaudeOptions & { maxResumes?: number; resumePrompt?: string }
): Promise<ClaudeResult> {
  const { maxResumes = 2, resumePrompt = "Continúa donde quedaste. Revisa qué queda pendiente y termina.", ...baseOptions } = options;
  let totalTurns = 0;
  let totalCost = 0;
  let lastSessionId: string | undefined;
  const start = Date.now();

  for (let attempt = 0; attempt <= maxResumes; attempt++) {
    const isResume = attempt > 0 && lastSessionId;

    if (isResume) {
      logger.info(
        { attempt, maxResumes, sessionId: lastSessionId, totalTurns },
        "Resuming Claude session after max_turns"
      );
    }

    const result = await runClaude({
      ...baseOptions,
      prompt: isResume ? resumePrompt : baseOptions.prompt,
      resumeSessionId: isResume ? lastSessionId : undefined,
    });

    totalTurns += result.turnsUsed ?? 0;
    totalCost += result.costUsd ?? 0;
    lastSessionId = result.sessionId;

    // Success — return with aggregated stats
    if (result.success) {
      return {
        ...result,
        turnsUsed: totalTurns,
        costUsd: totalCost,
        durationMs: Date.now() - start,
      };
    }

    // error_max_turns with a session we can resume — try again
    const isMaxTurns = result.error?.includes("error_max_turns");
    if (isMaxTurns && result.sessionId && attempt < maxResumes) {
      continue;
    }

    // Non-retriable failure or retries exhausted
    return {
      ...result,
      turnsUsed: totalTurns,
      costUsd: totalCost,
      durationMs: Date.now() - start,
      error: result.error + (attempt > 0 ? ` (after ${attempt} resume(s), ${totalTurns} total turns)` : ""),
    };
  }

  // Safety net
  return {
    success: false,
    output: "",
    error: `Max resumes exhausted (${totalTurns} total turns)`,
    turnsUsed: totalTurns,
    costUsd: totalCost,
    durationMs: Date.now() - start,
  };
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
