import type { HealthMonitoring, RuntimeKind } from "@nexus/shared";

export type ComponentRole = "backend" | "frontend" | "fullstack" | "static";

/** How to run a command inside the app's release directory. `{PORT}` is substituted at runtime. */
export interface CommandSpec {
  /** Logical executable: "node", "npm", "python", "pip" — resolved to managed runtimes at deploy time. */
  command: string;
  args: string[];
  /** Extra environment for this command (e.g. PYTHONPATH for src layouts). */
  env?: Record<string, string>;
}

export interface ComponentAnalysis {
  role: ComponentRole;
  /** Relative path from the project root ("" for root). */
  path: string;
  runtime: RuntimeKind;
  language: "javascript" | "typescript" | "python" | "html";
  framework: string; // "Express", "FastAPI", "React", "Next.js", "Static site"...
  packageManager: "npm" | "yarn" | "pnpm" | "pip" | "poetry" | "uv" | "pipenv" | null;
  install: CommandSpec | null;
  build: CommandSpec | null;
  start: CommandSpec | null;
  /** Build output folder for frontends/static sites (served by the gateway). */
  staticDir: string | null;
  entryFile: string | null;
  runtimeVersion: string | null;
  dependencies: string[];
  /** Packages Nexus adds so the app can run as a Windows service (e.g. waitress, uvicorn). */
  extraPackages?: string[];
}

export interface EnvVarRequirement {
  name: string;
  /** Where we saw it: ".env.example", "src/db.js"... */
  sources: string[];
  exampleValue: string | null;
  category: "database" | "storage" | "port" | "secret" | "url" | "config";
  /** Nexus will provide this automatically. */
  managed: boolean;
}

export type DatabaseKind = "postgresql" | "mysql" | "sqlite" | "mongodb" | "mssql" | "unknown-sql";

/** One way the app might read its database settings. */
export interface DbConfigPattern {
  kind: "url" | "discrete";
  /** e.g. { url: "DATABASE_URL" } or { host: "DB_HOST", port: "DB_PORT", ... } */
  vars: Partial<Record<"url" | "host" | "port" | "name" | "user" | "password" | "ssl", string>>;
  confidence: number; // 0..1
  sources: string[];
}

export interface DatabaseRequirement {
  required: boolean;
  kind: DatabaseKind | null;
  /** Evidence in plain words: "Uses the pg library", "DATABASE_URL in .env.example". */
  evidence: string[];
  libraries: string[];
  patterns: DbConfigPattern[];
}

export interface MigrationInfo {
  tool: "prisma" | "knex" | "sequelize" | "typeorm" | "drizzle" | "alembic" | "django" | "node-pg-migrate" | "sql-files";
  command: CommandSpec | null;
  /** Safe to run automatically on an empty database. */
  autoRunnable: boolean;
  description: string;
}

export interface ProjectAnalysis {
  name: string;
  root: string;
  runtime: RuntimeKind;
  /** Human summary: "Node.js + Express backend, React frontend". */
  summary: string;
  components: ComponentAnalysis[];
  env: EnvVarRequirement[];
  database: DatabaseRequirement;
  storage: { required: boolean; evidence: string[] };
  port: { value: number | null; envVar: string | null; evidence: string | null };
  health: HealthMonitoring;
  /** Pre-provenance persisted analyses used this field. Read only during migration. */
  healthPath?: string | null;
  migrations: MigrationInfo | null;
  hasDockerfile: boolean;
  externalAccessRecommended: boolean;
  warnings: string[];
}
