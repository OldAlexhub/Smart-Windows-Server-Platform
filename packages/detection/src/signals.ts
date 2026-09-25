import { BRAND } from "@nexus/shared";
import type { ProjectSnapshot } from "./snapshot";
import { joinRel } from "./snapshot";
import type {
  DatabaseKind,
  DbConfigPattern,
  EnvVarRequirement,
  MigrationInfo,
  ProjectAnalysis,
} from "./types";

// =====================================================================================
// Environment variables
// =====================================================================================

const ENV_EXAMPLE_FILES = /(^|\/)(\.env\.(example|sample|template|dist|defaults)|example\.env|env\.example|\.env\.local\.example)$/i;
const ENV_REAL_FILES = /(^|\/)\.env(\.(development|production|local))?$/i;

const IGNORED_ENV = new Set([
  "NODE_ENV",
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "PWD",
  "CI",
  "TZ",
  "LANG",
  "DEBUG",
  "TERM",
  "SHELL",
  "APPDATA",
  "TEMP",
  "TMP",
  "HOSTNAME",
  "npm_package_version",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "PUBLIC_URL",
]);

/** Secrets Nexus can generate itself (random values), as opposed to third-party API keys. */
const GENERATABLE_SECRET = /^(APP_|SESSION_|COOKIE_|JWT_|AUTH_|TOKEN_|ENCRYPTION_|FLASK_|DJANGO_|NEXTAUTH_)?(SECRET|SECRET_KEY|KEY_SECRET|SIGNING_KEY|ENCRYPTION_KEY|APP_KEY)$|^(JWT|SESSION|COOKIE|AUTH|NEXTAUTH|APP)_SECRET$/;

export function categorizeEnv(name: string): EnvVarRequirement["category"] {
  if (isDatabaseVar(name)) return "database";
  if (/^(PORT|HOST|BIND|LISTEN_ADDR|HTTP_PORT|SERVER_PORT)$/.test(name)) return "port";
  if (/(UPLOAD|STORAGE|FILES?_(DIR|PATH|ROOT)|MEDIA_ROOT|ATTACHMENTS?)/.test(name)) return "storage";
  if (/(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY|_KEY$)/.test(name)) return "secret";
  if (/(_URL|_URI|_ENDPOINT|_ORIGIN|_HOST)$/.test(name)) return "url";
  return "config";
}

function isDatabaseVar(name: string): boolean {
  return (
    /^(DATABASE|DB|PG|POSTGRES|POSTGRESQL|MYSQL|MONGO|MONGODB|SQL)(_|$)/.test(name) ||
    /^PG(HOST|PORT|DATABASE|USER|PASSWORD|SSLMODE)$/.test(name) ||
    /_(DATABASE_URL|DB_URL|DATABASE_URI|DB_(HOST|PORT|NAME|USER|PASSWORD|PASS))$/.test(name) ||
    name === "SQLALCHEMY_DATABASE_URI"
  );
}

function isManaged(name: string, category: EnvVarRequirement["category"]): boolean {
  if (category === "database" || category === "port" || category === "storage") return true;
  return GENERATABLE_SECRET.test(name);
}

export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out.set(m[1]!, value);
  }
  return out;
}

const JS_ENV = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
];
const PY_ENV = [
  /os\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
  /os\.environ\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
  /os\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
  /env\(\s*["']([A-Z_][A-Z0-9_]*)["']/g, // django-environ / environs
];

export function detectEnv(snap: ProjectSnapshot, a: ProjectAnalysis): void {
  const found = new Map<string, EnvVarRequirement>();
  const add = (name: string, source: string, example: string | null) => {
    // Variables Nexus itself injects (NEXUS_API_TOKEN...) are not requirements of the app.
    if (IGNORED_ENV.has(name) || name.startsWith("npm_") || name.startsWith(BRAND.envPrefix)) return;
    const existing = found.get(name);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (existing.exampleValue === null && example !== null) existing.exampleValue = example;
      return;
    }
    const category = categorizeEnv(name);
    found.set(name, { name, sources: [source], exampleValue: example, category, managed: isManaged(name, category) });
  };

  for (const f of snap.files.filter((f) => ENV_EXAMPLE_FILES.test(f))) {
    for (const [k, v] of parseDotenv(snap.read(f) ?? "")) add(k, f, v || null);
  }
  // Real .env files: names only. Values may be production secrets and are never copied.
  for (const f of snap.files.filter((f) => ENV_REAL_FILES.test(f))) {
    for (const k of parseDotenv(snap.read(f) ?? "").keys()) add(k, f, null);
  }
  for (const f of snap.sources()) {
    const text = snap.read(f);
    if (!text) continue;
    const patterns = f.endsWith(".py") ? PY_ENV : JS_ENV;
    for (const re of patterns) for (const m of text.matchAll(re)) add(m[1]!, f, null);
    if (!f.endsWith(".py")) {
      for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g)) {
        for (const part of m[1]!.split(",")) {
          const name = part.split(/[:=]/)[0]!.trim();
          if (/^[A-Z_][A-Z0-9_]*$/.test(name)) add(name, f, null);
        }
      }
    }
  }
  a.env = [...found.values()].sort((x, y) => x.name.localeCompare(y.name));
}

// =====================================================================================
// Database
// =====================================================================================

const DB_LIBS: Record<string, { kind: DatabaseKind | null; label: string }> = {
  // node
  pg: { kind: "postgresql", label: "pg" },
  "pg-promise": { kind: "postgresql", label: "pg-promise" },
  postgres: { kind: "postgresql", label: "postgres.js" },
  "@neondatabase/serverless": { kind: "postgresql", label: "Neon driver" },
  "@prisma/client": { kind: null, label: "Prisma" },
  prisma: { kind: null, label: "Prisma" },
  sequelize: { kind: null, label: "Sequelize" },
  typeorm: { kind: null, label: "TypeORM" },
  knex: { kind: null, label: "Knex" },
  "drizzle-orm": { kind: null, label: "Drizzle" },
  "@mikro-orm/core": { kind: null, label: "MikroORM" },
  mysql: { kind: "mysql", label: "mysql" },
  mysql2: { kind: "mysql", label: "mysql2" },
  mongodb: { kind: "mongodb", label: "MongoDB driver" },
  mongoose: { kind: "mongodb", label: "Mongoose" },
  sqlite3: { kind: "sqlite", label: "sqlite3" },
  "better-sqlite3": { kind: "sqlite", label: "better-sqlite3" },
  mssql: { kind: "mssql", label: "mssql" },
  tedious: { kind: "mssql", label: "tedious" },
  // python
  psycopg: { kind: "postgresql", label: "psycopg" },
  psycopg2: { kind: "postgresql", label: "psycopg2" },
  "psycopg2-binary": { kind: "postgresql", label: "psycopg2" },
  asyncpg: { kind: "postgresql", label: "asyncpg" },
  sqlalchemy: { kind: null, label: "SQLAlchemy" },
  sqlmodel: { kind: null, label: "SQLModel" },
  "flask-sqlalchemy": { kind: null, label: "Flask-SQLAlchemy" },
  "tortoise-orm": { kind: null, label: "Tortoise ORM" },
  peewee: { kind: null, label: "Peewee" },
  pymysql: { kind: "mysql", label: "PyMySQL" },
  mysqlclient: { kind: "mysql", label: "mysqlclient" },
  pymongo: { kind: "mongodb", label: "PyMongo" },
  motor: { kind: "mongodb", label: "Motor" },
  pyodbc: { kind: "mssql", label: "pyodbc" },
};

function kindFromUrl(url: string | null): DatabaseKind | null {
  if (!url) return null;
  if (/^postgres(ql)?(\+\w+)?:\/\//i.test(url)) return "postgresql";
  if (/^mysql(\+\w+)?:\/\//i.test(url) || /^mariadb:/i.test(url)) return "mysql";
  if (/^mongodb(\+srv)?:\/\//i.test(url)) return "mongodb";
  if (/^(sqlite|file):/i.test(url)) return "sqlite";
  if (/^(mssql|sqlserver):/i.test(url)) return "mssql";
  return null;
}

const URL_VAR = /^(DATABASE_URL|DATABASE_URI|DB_URL|DB_URI|DB_CONNECTION_STRING|POSTGRES_URL|POSTGRESQL_URL|PG_URL|PG_CONNECTION_STRING|SQLALCHEMY_DATABASE_URI|[A-Z]+_DATABASE_URL)$/;
const PART_SUFFIX: [RegExp, keyof DbConfigPattern["vars"]][] = [
  [/(HOST|HOSTNAME|SERVER)$/, "host"],
  [/PORT$/, "port"],
  [/(NAME|DATABASE|DB)$/, "name"],
  [/(USER|USERNAME)$/, "user"],
  [/(PASSWORD|PASS|PWD)$/, "password"],
  [/(SSL|SSLMODE)$/, "ssl"],
];

/** Groups DB_HOST/DB_PORT/... style variables by prefix into candidate configurations. */
export function findDbPatterns(env: EnvVarRequirement[], usesNodePg: boolean): DbConfigPattern[] {
  const patterns: DbConfigPattern[] = [];
  const inCode = (e: EnvVarRequirement) => e.sources.some((s) => !/(^|\/)\.env/.test(s) && !/env\.example$/i.test(s));

  for (const e of env) {
    if (URL_VAR.test(e.name)) {
      const kind = kindFromUrl(e.exampleValue);
      if (kind && kind !== "postgresql") continue;
      patterns.push({ kind: "url", vars: { url: e.name }, confidence: inCode(e) ? 0.95 : 0.8, sources: e.sources });
    }
  }

  const groups = new Map<string, DbConfigPattern>();
  for (const e of env.filter((x) => x.category === "database" && !URL_VAR.test(x.name))) {
    for (const [re, part] of PART_SUFFIX) {
      const m = e.name.match(re);
      if (!m) continue;
      // DB_HOST → "DB", PGHOST → "PG", POSTGRES_DB → "POSTGRES"
      const prefix = e.name.slice(0, m.index).replace(/_$/, "");
      if (!prefix) continue;
      const g = groups.get(prefix) ?? { kind: "discrete" as const, vars: {}, confidence: 0, sources: [] };
      if (!g.vars[part]) g.vars[part] = e.name;
      for (const s of e.sources) if (!g.sources.includes(s)) g.sources.push(s);
      groups.set(prefix, g);
      break;
    }
  }
  for (const g of groups.values()) {
    const n = Object.keys(g.vars).length;
    if (n < 2 || (!g.vars.host && !g.vars.name)) continue;
    g.confidence = Math.min(0.9, 0.35 + n * 0.1 + (g.sources.some((s) => !s.includes(".env")) ? 0.1 : 0));
    patterns.push(g);
  }

  // node-postgres reads PGHOST, PGUSER... natively even when the code never mentions them.
  if (usesNodePg && patterns.length === 0) {
    patterns.push({
      kind: "discrete",
      vars: { host: "PGHOST", port: "PGPORT", name: "PGDATABASE", user: "PGUSER", password: "PGPASSWORD" },
      confidence: 0.6,
      sources: ["pg library defaults"],
    });
  }
  return patterns.sort((x, y) => y.confidence - x.confidence);
}

const MONGO_URL_VAR = /^(MONGO(DB)?_(URI|URL|CONNECTION_STRING|CONN_STRING)|[A-Z]+_MONGO(DB)?_(URI|URL)|MONGO(DB)?)$/;

/**
 * Connection variables of a MongoDB app. URL styles (MONGODB_URI, MONGO_URL, DATABASE_URL with a
 * mongodb:// example) share one slot. Nothing found → the names mongoose/pymongo apps use most.
 */
export function findMongoPatterns(env: EnvVarRequirement[]): DbConfigPattern[] {
  const inCode = (e: EnvVarRequirement) => e.sources.some((s) => !/(^|\/)\.env/.test(s) && !/env\.example$/i.test(s));
  const patterns: DbConfigPattern[] = [];
  for (const e of env) {
    const mongoExample = kindFromUrl(e.exampleValue) === "mongodb";
    if (MONGO_URL_VAR.test(e.name) || (mongoExample && e.category === "database") || (URL_VAR.test(e.name) && mongoExample)) {
      patterns.push({ kind: "url", vars: { url: e.name }, confidence: inCode(e) ? 0.95 : 0.8, sources: e.sources });
    }
  }
  const parts = env.filter((e) => /^MONGO(DB)?_/.test(e.name) && !MONGO_URL_VAR.test(e.name));
  if (parts.length) {
    const vars: DbConfigPattern["vars"] = {};
    for (const e of parts) {
      const tail = e.name.replace(/^MONGO(DB)?_/, "");
      for (const [re, part] of PART_SUFFIX) {
        if (re.test(tail) && !vars[part]) {
          vars[part] = e.name;
          break;
        }
      }
    }
    if (vars.host || vars.name) patterns.push({ kind: "discrete", vars, confidence: 0.7, sources: [...new Set(parts.flatMap((p) => p.sources))] });
  }
  if (!patterns.length) {
    for (const name of ["MONGODB_URI", "MONGO_URL", "MONGO_URI"]) {
      patterns.push({ kind: "url", vars: { url: name }, confidence: 0.5, sources: ["common MongoDB settings"] });
    }
  }
  return patterns.sort((x, y) => y.confidence - x.confidence);
}

export function detectDatabase(snap: ProjectSnapshot, a: ProjectAnalysis): void {
  const libs = new Set<string>();
  const evidence: string[] = [];
  let kind = null as DatabaseKind | null;
  const setKind = (k: DatabaseKind | null) => {
    if (k && (!kind || kind === "unknown-sql" || kind === "sqlite")) kind = k;
  };

  for (const c of a.components) {
    for (const d of c.dependencies) {
      const lib = DB_LIBS[d];
      if (!lib) continue;
      if (!libs.has(lib.label)) evidence.push(`Uses ${lib.label}`);
      libs.add(lib.label);
      setKind(lib.kind);
    }
    if (c.framework === "Django") {
      const settings = snap.list(c.path, /settings(\/\w+)?\.py$/).map((f) => snap.read(f) ?? "").join("\n");
      if (/django\.db\.backends\.postgresql/.test(settings)) setKind("postgresql");
      else if (/django\.db\.backends\.mysql/.test(settings)) setKind("mysql");
      else if (/dj_database_url|DATABASE_URL/.test(settings)) setKind("unknown-sql");
      else setKind("sqlite");
      if (!libs.has("Django ORM")) (libs.add("Django ORM"), evidence.push("Uses the Django ORM"));
    }
    // Prisma schema provider
    const prisma = snap.list(c.path, /schema\.prisma$/)[0];
    if (prisma) {
      const provider = snap.read(prisma)?.match(/provider\s*=\s*"(\w+)"/g)?.map((p) => p.match(/"(\w+)"/)![1]).find((p) => p !== "prisma-client-js");
      if (provider === "postgresql" || provider === "postgres") setKind("postgresql");
      else if (provider === "mysql") setKind("mysql");
      else if (provider === "sqlite") setKind("sqlite");
      else if (provider === "mongodb") setKind("mongodb");
    }
  }

  const dbEnv = a.env.filter((e) => e.category === "database");
  for (const e of dbEnv) setKind(kindFromUrl(e.exampleValue));
  if (dbEnv.length) evidence.push(`${dbEnv.map((e) => e.name).slice(0, 3).join(", ")}${dbEnv.length > 3 ? "…" : ""} settings`);

  const required = libs.size > 0 || dbEnv.length > 0;
  if (required && !kind) kind = "unknown-sql";

  a.database = {
    required,
    kind,
    evidence,
    libraries: [...libs],
    patterns: !required ? [] : kind === "mongodb" ? findMongoPatterns(a.env) : findDbPatterns(a.env, a.components.some((c) => c.dependencies.includes("pg"))),
  };
  if (kind && kind !== "postgresql" && kind !== "unknown-sql" && kind !== "mongodb") {
    const label = { mysql: "MySQL", mongodb: "MongoDB", sqlite: "a local SQLite file", mssql: "SQL Server" }[kind as string];
    a.warnings.push(
      kind === "sqlite"
        ? "This application stores data in a local SQLite file. Nexus will keep that file safe and back it up."
        : `This application is built for ${label}. Nexus manages PostgreSQL today; ${label} support arrives as a plugin.`,
    );
  }
}

// =====================================================================================
// File storage
// =====================================================================================

const STORAGE_LIBS: Record<string, string> = {
  multer: "Handles file uploads (multer)",
  formidable: "Handles file uploads (formidable)",
  busboy: "Handles file uploads (busboy)",
  "express-fileupload": "Handles file uploads",
  "@fastify/multipart": "Handles file uploads",
  "@aws-sdk/client-s3": "Stores files in S3-compatible storage",
  "aws-sdk": "Uses AWS SDK (possibly S3 storage)",
  "python-multipart": "Handles file uploads",
  boto3: "Stores files in S3-compatible storage",
  pillow: "Processes images",
  sharp: "Processes images",
  pdfkit: "Generates PDF files",
  reportlab: "Generates PDF files",
};

export function detectStorage(snap: ProjectSnapshot, a: ProjectAnalysis): void {
  const evidence = new Set<string>();
  for (const c of a.components) for (const d of c.dependencies) if (STORAGE_LIBS[d]) evidence.add(STORAGE_LIBS[d]!);
  for (const e of a.env.filter((e) => e.category === "storage")) evidence.add(`${e.name} setting`);
  for (const f of snap.sources()) {
    const t = snap.read(f);
    if (t && /UploadFile|request\.files\b|FileStorage|upload\.single\(|upload\.array\(/.test(t)) {
      evidence.add("Accepts file uploads");
      break;
    }
  }
  a.storage = { required: evidence.size > 0, evidence: [...evidence] };
}

// =====================================================================================
// Port & health endpoint
// =====================================================================================

const FRAMEWORK_DEFAULT_PORT: Record<string, number> = {
  "Next.js": 3000,
  Nuxt: 3000,
  Express: 3000,
  Flask: 5000,
  FastAPI: 8000,
  Django: 8000,
};

export function detectPort(snap: ProjectSnapshot, a: ProjectAnalysis): void {
  const main = a.components.find((c) => c.role === "backend" || c.role === "fullstack");
  if (!main) return;
  // Servers Nexus launches with an explicit port flag always honour it.
  if (main.start?.args.some((x) => x.includes("{PORT}")) || main.role === "fullstack") {
    a.port = { value: FRAMEWORK_DEFAULT_PORT[main.framework] ?? null, envVar: "PORT", evidence: "Nexus sets the port when starting the app" };
    return;
  }
  const files = snap.sources(main.path);
  const ordered = main.entryFile ? [joinRel(main.path, main.entryFile), ...files] : files;
  for (const f of ordered) {
    const t = snap.read(f);
    if (!t) continue;
    const env = t.match(/process\.env\.(PORT|HTTP_PORT|SERVER_PORT|APP_PORT)\s*(?:\|\||\?\?)\s*["']?(\d{2,5})/) ??
      t.match(/(?:os\.environ\.get|os\.getenv)\(\s*["'](PORT|HTTP_PORT|APP_PORT)["']\s*,\s*["']?(\d{2,5})/);
    if (env) {
      a.port = { value: Number(env[2]), envVar: env[1]!, evidence: f };
      return;
    }
    const envOnly = t.match(/process\.env\.(PORT|HTTP_PORT|SERVER_PORT|APP_PORT)\b/) ?? t.match(/["'](PORT)["']/);
    const fixed = t.match(/\.listen\(\s*(\d{2,5})\b/) ?? t.match(/\bport\s*=\s*(\d{2,5})\b/);
    if (envOnly) {
      a.port = { value: fixed ? Number(fixed[1]) : null, envVar: envOnly[1]!, evidence: f };
      return;
    }
    if (fixed) {
      a.port = { value: Number(fixed[1]), envVar: null, evidence: f };
      a.warnings.push(
        `This application always uses port ${fixed[1]}. Nexus will work with it, but two apps can't share that port.`,
      );
      return;
    }
  }
  a.port = { value: FRAMEWORK_DEFAULT_PORT[main.framework] ?? null, envVar: "PORT", evidence: null };
}

const HEALTH_PATHS = ["/health", "/healthz", "/api/health", "/api/healthz", "/status", "/api/status", "/_health", "/livez", "/readyz", "/ping", "/api/ping"];

export function detectHealth(snap: ProjectSnapshot, a: ProjectAnalysis): void {
  const main = a.components.find((c) => c.role === "backend" || c.role === "fullstack");
  if (!main) return;
  const found = new Set<string>();
  for (const f of snap.sources(main.path)) {
    const t = snap.read(f);
    if (!t) continue;
    for (const m of t.matchAll(/(?:\.(?:get|route|all)|@\w+\.(?:get|route|api_route))\(\s*["'`](\/[\w/-]*)["'`]/g)) {
      if (HEALTH_PATHS.includes(m[1]!)) found.add(m[1]!);
    }
    // Next.js app router: app/api/health/route.ts
  }
  for (const f of snap.list(main.path, /(^|\/)(app|pages)\/api\/(health|healthz|status)(\/route)?\.(t|j)sx?$/)) {
    const m = f.match(/\/api\/(health|healthz|status)/);
    if (m) found.add(`/api/${m[1]}`);
  }
  a.healthPath = HEALTH_PATHS.find((p) => found.has(p)) ?? null;
}

// =====================================================================================
// Migrations
// =====================================================================================

const MIGRATE_SCRIPTS = ["migrate", "db:migrate", "migrate:latest", "migration:run", "migrate:deploy", "db:deploy"];

export function detectMigrations(snap: ProjectSnapshot, a: ProjectAnalysis): void {
  if (!a.database.required) return;
  const main = a.components.find((c) => c.role === "backend" || c.role === "fullstack");
  if (!main) return;
  const p = main.path;
  const deps = new Set(main.dependencies);
  const pkg = snap.json<{ scripts?: Record<string, string>; devDependencies?: Record<string, string> }>(joinRel(p, "package.json"));
  const allDeps = new Set([...deps, ...Object.keys(pkg?.devDependencies ?? {})]);
  const script = MIGRATE_SCRIPTS.find((s) => pkg?.scripts?.[s]);
  const npmRun = (s: string) => ({ command: "npm", args: ["run", s] });
  const found = (m: MigrationInfo) => (a.migrations = m);

  if (main.runtime === "node") {
    if (allDeps.has("prisma") || allDeps.has("@prisma/client")) {
      const hasMigrations = snap.list(p, /prisma\/migrations\/.+\/migration\.sql$/).length > 0;
      return void found(
        hasMigrations
          ? { tool: "prisma", command: { command: "npx", args: ["prisma", "migrate", "deploy"] }, autoRunnable: true, description: "Prisma migrations" }
          : { tool: "prisma", command: { command: "npx", args: ["prisma", "db", "push", "--skip-generate"] }, autoRunnable: false, description: "Create tables from the Prisma schema" },
      );
    }
    if (script) return void found({ tool: guessTool(allDeps), command: npmRun(script), autoRunnable: true, description: `The app's "${script}" script` });
    if (allDeps.has("knex") && snap.list(p, /knexfile\.(js|ts|cjs|mjs)$/).length) {
      return void found({ tool: "knex", command: { command: "npx", args: ["knex", "migrate:latest"] }, autoRunnable: true, description: "Knex migrations" });
    }
    if (allDeps.has("sequelize-cli") || snap.has(joinRel(p, ".sequelizerc"))) {
      return void found({ tool: "sequelize", command: { command: "npx", args: ["sequelize-cli", "db:migrate"] }, autoRunnable: true, description: "Sequelize migrations" });
    }
    if (allDeps.has("drizzle-kit")) {
      return void found({ tool: "drizzle", command: { command: "npx", args: ["drizzle-kit", "migrate"] }, autoRunnable: true, description: "Drizzle migrations" });
    }
    if (allDeps.has("node-pg-migrate")) {
      return void found({ tool: "node-pg-migrate", command: { command: "npx", args: ["node-pg-migrate", "up"] }, autoRunnable: true, description: "node-pg-migrate migrations" });
    }
    if (allDeps.has("typeorm")) {
      return void found({ tool: "typeorm", command: null, autoRunnable: false, description: "TypeORM (set the migration command in Advanced)" });
    }
  }

  if (main.runtime === "python") {
    if (main.framework === "Django") {
      return void found({ tool: "django", command: { command: "python", args: ["manage.py", "migrate", "--noinput"] }, autoRunnable: true, description: "Django migrations" });
    }
    if (snap.has(joinRel(p, "alembic.ini"))) {
      return void found({ tool: "alembic", command: { command: "python", args: ["-m", "alembic", "upgrade", "head"] }, autoRunnable: true, description: "Alembic migrations" });
    }
  }

  const sql = snap.list(p, /(^|\/)(schema|init|db\/schema|database\/schema|sql\/schema)\.sql$/)[0] ?? snap.list(p, /(^|\/)migrations\/\d+[^/]*\.sql$/)[0];
  if (sql) {
    found({ tool: "sql-files", command: null, autoRunnable: false, description: `Initialize schema from ${sql}` });
  }
}

function guessTool(deps: Set<string>): MigrationInfo["tool"] {
  if (deps.has("knex")) return "knex";
  if (deps.has("sequelize")) return "sequelize";
  if (deps.has("typeorm")) return "typeorm";
  if (deps.has("drizzle-orm")) return "drizzle";
  if (deps.has("node-pg-migrate")) return "node-pg-migrate";
  return "sql-files";
}

/** Built-in detectors in dependency order (database needs env; migrations need database). */
export const BUILTIN_SIGNAL_DETECTORS = [detectEnv, detectDatabase, detectStorage, detectPort, detectHealth, detectMigrations];

