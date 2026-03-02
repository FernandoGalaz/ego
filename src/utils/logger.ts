import pino from "pino";

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
  level: process.env.LOG_LEVEL ?? "info",
});

export function phaseLogger(taskId: string, phase: string) {
  return logger.child({ taskId, phase });
}
