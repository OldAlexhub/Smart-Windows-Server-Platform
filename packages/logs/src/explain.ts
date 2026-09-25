import type { DiagnosticCheck, FriendlyProblem, RepairAction } from "@nexus/shared";

/** What Nexus knows about the app's surroundings when an error happens. */
export interface ExplainContext {
  appName: string;
  /** The port Nexus's PostgreSQL listens on. */
  databasePort?: number | null;
  databaseRunning?: boolean | null;
  /** Result of Nexus testing the app's credentials itself. */
  credentialsValid?: boolean | null;
  internetAvailable?: boolean | null;
}

interface Rule {
  test: RegExp;
  build: (m: RegExpMatchArray, ctx: ExplainContext, text: string) => Omit<FriendlyProblem, "technical">;
}

const check = (label: string, ok: boolean | null | undefined, detail?: string): DiagnosticCheck => ({
  label,
  status: ok === true ? "ok" : ok === false ? "failed" : "unknown",
  ...(detail ? { detail } : {}),
});

const repair = (id: string, label: string, requiresConfirmation = false, params?: Record<string, string>): RepairAction => ({
  id,
  label,
  requiresConfirmation,
  ...(params ? { params } : {}),
});

const dbChecks = (ctx: ExplainContext, credentials?: boolean | null): DiagnosticCheck[] => [
  check("Database server", ctx.databaseRunning, ctx.databaseRunning === false ? "Not running" : ctx.databaseRunning ? "Running" : undefined),
  check("Network", true, "Working"),
  check("Credentials", credentials ?? ctx.credentialsValid, (credentials ?? ctx.credentialsValid) ? "Working" : undefined),
];

const RULES: Rule[] = [
  // ---------------- database ----------------
  {
    test: /password authentication failed for user "?([\w-]+)"?|FATAL:\s+role "([\w-]+)" does not exist/i,
    build: (_m, ctx) => ({
      title: "Database Sign-in Problem",
      summary: `${ctx.appName} is using a database password that no longer works.`,
      checks: dbChecks(ctx, false),
      cause: `${ctx.appName} has outdated database credentials.`,
      repair: repair("database.repair-connection", "Repair Connection"),
    }),
  },
  {
    test: /database "([^"]+)" does not exist/i,
    build: (m, ctx) => ({
      title: "Database Missing",
      summary: `${ctx.appName} expects a database called "${m[1]}", which doesn't exist.`,
      checks: dbChecks(ctx),
      cause: "The database was removed or the application points at the wrong name.",
      repair: repair("database.repair-connection", "Reconnect to the right database"),
    }),
  },
  {
    test: /relation "([^"]+)" does not exist|no such table:\s*(\w+)|Table '[^']*\.?(\w+)' doesn't exist/i,
    build: (m, ctx) => ({
      title: "Database Tables Missing",
      summary: `${ctx.appName} is looking for a table called "${m[1] ?? m[2] ?? m[3]}" that hasn't been created yet.`,
      checks: [check("Database server", ctx.databaseRunning ?? true, "Running"), check("Connection", true, "Working"), check("Tables", false, "Not set up")],
      cause: "The database structure (schema) has not been initialised for this version of the application.",
      repair: repair("app.run-migrations", "Set Up Database Tables", true),
    }),
  },
  {
    test: /(ECONNREFUSED|Connection refused|could not connect to server|connection to server at).*?(?:127\.0\.0\.1|localhost|::1)[:\s"]*(?:port\s*)?(\d{2,5})?/i,
    build: (m, ctx) => {
      const port = m[2] ? Number(m[2]) : null;
      const isDb = port === 5432 || port === 3306 || (port !== null && port === ctx.databasePort) || /postgres|psycopg|pg[.:]|sequelize|prisma|database/i.test(m.input ?? "");
      if (!isDb) {
        return {
          title: "Connection Problem",
          summary: `${ctx.appName} tried to reach another service on this computer${port ? ` (port ${port})` : ""}, but nothing answered.`,
          checks: [check("Target service", false, "Not answering")],
          cause: "A service the application depends on is not running.",
        };
      }
      const outdated = ctx.databaseRunning !== false && port !== null && ctx.databasePort != null && port !== ctx.databasePort;
      return {
        title: "Database Connection Problem",
        summary: `${ctx.appName} cannot currently connect to its database.`,
        checks: dbChecks(ctx),
        cause: outdated
          ? `${ctx.appName} is using an outdated database configuration.`
          : ctx.databaseRunning === false
            ? "The database server is not running."
            : "The database did not accept the connection.",
        repair: ctx.databaseRunning === false ? repair("database.start", "Start Database") : repair("database.repair-connection", "Repair Connection"),
      };
    },
  },
  // ---------------- ports ----------------
  {
    test: /EADDRINUSE.*?:(\d+)|address already in use|Only one usage of each socket address/i,
    build: (m, ctx) => ({
      title: "Port Conflict",
      summary: `${ctx.appName} could not start because another program is using ${m[1] ? `port ${m[1]}` : "its network port"}.`,
      checks: [check("Network port", false, "In use by another program")],
      cause: "Two programs tried to use the same network port.",
      repair: repair("app.reassign-port", "Move to a Free Port"),
    }),
  },
  // ---------------- dependencies ----------------
  {
    test: /Cannot find module '([^']+)'|ModuleNotFoundError: No module named '([^']+)'|ImportError: cannot import name/i,
    build: (m, ctx) => {
      const mod = m[1] ?? m[2];
      const local = mod?.startsWith(".") || mod?.includes("/") && !mod.startsWith("@");
      return {
        title: local ? "Application File Missing" : "Missing Component",
        summary: local
          ? `${ctx.appName} is looking for one of its own files (${mod}) that isn't there.`
          : `${ctx.appName} needs a component called "${mod}" that isn't installed.`,
        checks: [check("Application files", !local), check("Installed components", local ? null : false)],
        cause: local ? "The start command or project files may be out of date." : "The component list (package.json / requirements.txt) doesn't include it, or installation was incomplete.",
        ...(local ? {} : { repair: repair("app.reinstall", "Reinstall Components", true) }),
      };
    },
  },
  // ---------------- resources ----------------
  {
    test: /JavaScript heap out of memory|MemoryError|Cannot allocate memory|out of memory/i,
    build: (_m, ctx) => ({
      title: "Out of Memory",
      summary: `${ctx.appName} ran out of memory and stopped.`,
      checks: [check("Memory", false, "Limit reached")],
      cause: "The application needed more memory than it is allowed to use.",
      repair: repair("app.raise-memory-limit", "Allow More Memory", true),
    }),
  },
  {
    test: /ENOSPC|No space left on device|disk (is )?full/i,
    build: (_m, ctx) => ({
      title: "Drive Full",
      summary: `${ctx.appName} couldn't save data because the drive is full.`,
      checks: [check("Storage", false, "No space left")],
      cause: "The drive holding application data has run out of space.",
      repair: repair("storage.cleanup", "Free Up Space", true),
    }),
  },
  // ---------------- configuration ----------------
  {
    test: /KeyError: '([A-Z][A-Z0-9_]+)'|(?:Missing|missing|required) (?:required )?(?:environment )?(?:variable|env(?:ironment)? var(?:iable)?)[:\s]+"?'?([A-Z][A-Z0-9_]+)|([A-Z][A-Z0-9_]+) (?:is not set|must be set|is required)/,
    build: (m, ctx) => {
      const name = m[1] ?? m[2] ?? m[3]!;
      return {
        title: "Setting Needed",
        summary: `${ctx.appName} needs a setting called ${name} before it can run.`,
        checks: [check("Application settings", false, `${name} missing`)],
        cause: "This value is specific to your business (for example an API key) so Nexus can't create it automatically.",
        repair: repair("app.open-settings", `Add ${name}`, false, { variable: name }),
      };
    },
  },
  // ---------------- network ----------------
  {
    test: /getaddrinfo (ENOTFOUND|EAI_AGAIN) ([\w.-]+)|Name or service not known|Temporary failure in name resolution/i,
    build: (m, ctx) => ({
      title: "Internet Service Unreachable",
      summary: `${ctx.appName} couldn't reach ${m[2] ?? "an internet service"}.`,
      checks: [check("Internet connection", ctx.internetAvailable)],
      cause: ctx.internetAvailable === false ? "This computer is currently offline." : "The service's address could not be found. It may be down or mistyped in the settings.",
    }),
  },
  {
    test: /ETIMEDOUT|timed? ?out/i,
    build: (_m, ctx) => ({
      title: "Connection Timed Out",
      summary: `${ctx.appName} waited too long for another service to answer.`,
      checks: [check("Internet connection", ctx.internetAvailable)],
      cause: "A service the application depends on is slow or unreachable.",
    }),
  },
  // ---------------- code ----------------
  {
    test: /^(SyntaxError|IndentationError|TypeError|ReferenceError|NameError|AttributeError)[:\s](.*)$/m,
    build: (m, ctx) => ({
      title: "Application Code Error",
      summary: `${ctx.appName} hit a problem in its own code: ${m[2]!.trim().slice(0, 160)}`,
      checks: [check("Nexus services", true, "Working"), check("Application code", false)],
      cause: "This needs a change in the application's source code. Nexus never edits your code automatically. Deploy a fixed version or roll back to the previous one.",
      repair: repair("app.rollback", "Roll Back to Previous Version", true),
    }),
  },
  {
    test: /EACCES|EPERM|Permission denied|Access is denied/i,
    build: (_m, ctx) => ({
      title: "Permission Problem",
      summary: `${ctx.appName} tried to use a file or folder it isn't allowed to access.`,
      checks: [check("File access", false)],
      cause: "Applications can only write inside their own Nexus storage. The application may be writing to a fixed path.",
    }),
  },
];

/**
 * Turns raw technical errors into a plain-English FriendlyProblem.
 * Rule-based and offline; the AI assistant can add deeper explanations on top.
 */
export function explainError(technical: string, ctx: ExplainContext): FriendlyProblem {
  for (const rule of RULES) {
    const m = technical.match(rule.test);
    if (m) return { ...rule.build(m, ctx, technical), technical };
  }
  return {
    title: "Application Error",
    summary: `${ctx.appName} reported an error.`,
    checks: [],
    technical,
  };
}
