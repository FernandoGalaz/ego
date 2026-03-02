import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "./logger.js";

const LESSONS_FILE = "ego-lessons.md";
const MAX_LINES = 150;

export function getLessonsPath(repoPath: string): string {
  return join(repoPath, LESSONS_FILE);
}

export function readLessons(repoPath: string): string {
  const filePath = getLessonsPath(repoPath);
  if (!existsSync(filePath)) return "";

  try {
    const content = readFileSync(filePath, "utf-8");
    // Limit to MAX_LINES to keep context manageable
    const lines = content.split("\n");
    if (lines.length > MAX_LINES) {
      logger.warn({ lines: lines.length, max: MAX_LINES }, "Lessons file exceeds max lines, truncating");
      return lines.slice(0, MAX_LINES).join("\n");
    }
    return content;
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "Failed to read lessons file");
    return "";
  }
}

export function writeLessons(repoPath: string, content: string): void {
  const filePath = getLessonsPath(repoPath);
  try {
    writeFileSync(filePath, content, "utf-8");
    logger.info({ path: filePath }, "Lessons file updated");
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "Failed to write lessons file");
  }
}

export function buildLessonsPrompt(repoPath: string): string {
  const lessons = readLessons(repoPath);
  if (!lessons) return "";

  return `\n## Lecciones aprendidas de ejecuciones anteriores
Lee atentamente estas lecciones antes de comenzar. Aplica lo que sea relevante para esta tarea.

${lessons}`;
}
