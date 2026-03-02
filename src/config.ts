import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { logger } from "./utils/logger.js";

const ProjectConfigSchema = z.object({
  name: z.string(),
  repo: z.string().transform((p) => resolve(p.replace("~", process.env.HOME ?? ""))),
  worktreesDir: z.string().default("../worktrees"),
  baseBranch: z.string().default("main"),
  linear: z.object({
    teamId: z.string(),
    projectId: z.string().optional(),
  }),
  sentry: z
    .object({
      org: z.string(),
      project: z.string(),
    })
    .optional(),
  coolify: z
    .object({
      appId: z.string(),
      apiUrl: z.string().url(),
      apiToken: z.string().optional(),
      devUrl: z.string().url(),
      dockerImageTag: z.string().optional(),
    })
    .optional(),
  github: z.object({
    repo: z.string(),
    ciWorkflow: z.string().default("ci.yml"),
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

const EgoConfigSchema = z.object({
  redis: z
    .object({
      host: z.string().default("localhost"),
      port: z.number().default(6379),
    })
    .default({}),
  server: z
    .object({
      port: z.number().default(3847),
      host: z.string().default("0.0.0.0"),
    })
    .default({}),
  safety: z
    .object({
      maxFailuresPerHour: z.number().default(5),
      maxFailuresPerFile: z.number().default(3),
      sentryPauseSeconds: z.number().default(300),
      cooldownSeconds: z.number().default(30),
    })
    .default({}),
  notifications: z
    .object({
      slack: z
        .object({
          webhookUrl: z.string().url(),
          channel: z.string().optional(),
        })
        .optional(),
      telegram: z
        .object({
          botToken: z.string(),
          chatId: z.string(),
        })
        .optional(),
    })
    .default({}),
});

export type EgoConfig = z.infer<typeof EgoConfigSchema>;

let _projects: Map<string, ProjectConfig> = new Map();
let _egoConfig: EgoConfig | null = null;

function getConfigDir(): string {
  return process.env.EGO_CONFIG_DIR ?? join(process.cwd(), "projects");
}

function getEgoConfigPath(): string {
  return process.env.EGO_CONFIG ?? join(process.cwd(), "ego.config.json");
}

export function loadEgoConfig(): EgoConfig {
  if (_egoConfig) return _egoConfig;

  const configPath = getEgoConfigPath();
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    _egoConfig = EgoConfigSchema.parse(raw);
  } else {
    _egoConfig = EgoConfigSchema.parse({});
  }
  return _egoConfig;
}

export function loadProject(name: string): ProjectConfig {
  if (_projects.has(name)) return _projects.get(name)!;

  const configDir = getConfigDir();
  const filePath = join(configDir, `${name}.json`);

  if (!existsSync(filePath)) {
    throw new Error(`Project config not found: ${filePath}`);
  }

  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  const config = ProjectConfigSchema.parse(raw);
  _projects.set(name, config);
  return config;
}

export function loadAllProjects(): Map<string, ProjectConfig> {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) return _projects;

  const files = readdirSync(configDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const name = file.replace(".json", "");
    try {
      loadProject(name);
    } catch (err) {
      logger.warn({ name, err }, "Failed to load project config");
    }
  }
  return _projects;
}

export function findProjectByLinearTeam(teamId: string): ProjectConfig | undefined {
  loadAllProjects();
  for (const [, config] of _projects) {
    if (config.linear.teamId === teamId) return config;
  }
  return undefined;
}

export function findProjectBySentryProject(slug: string): ProjectConfig | undefined {
  loadAllProjects();
  for (const [, config] of _projects) {
    if (config.sentry?.project === slug) return config;
  }
  return undefined;
}
