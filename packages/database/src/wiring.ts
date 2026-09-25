import type { DatabaseRequirement, DbConfigPattern, EnvVarRequirement } from "@nexus/detection";
import type { ConnectionInfo } from "./manager";

/**
 * A "slot" is one logical database connection the app expects. Patterns that describe the same
 * connection in different styles (DATABASE_URL and DB_HOST/DB_NAME/...) share a slot, and Nexus
 * simply fills them all. Different slots (DATABASE_URL vs REPORTING_DATABASE_URL) mean the app
 * talks to several databases, and only then might we need to ask the user.
 */
export interface ConnectionSlot {
  key: string; // "" for the primary family, otherwise the prefix ("REPORTING")
  label: string;
  patterns: DbConfigPattern[];
  primaryFamily: boolean;
}

export interface WiringChoice {
  slotKey: string;
  /** Plain-language description, e.g. "Main database (DATABASE_URL)". */
  label: string;
  variables: string[];
}

export type WiringPlan =
  | { status: "auto"; env: Record<string, string>; slot: string; unconnected: WiringChoice[]; note: string }
  | { status: "assumed"; env: Record<string, string>; note: string }
  | { status: "ambiguous"; question: string; choices: WiringChoice[] };

/** Prefixes that all mean "the app's main database". */
const PRIMARY_PREFIXES = new Set(["", "DATABASE", "DB", "PG", "POSTGRES", "POSTGRESQL", "SQL", "SQLALCHEMY"]);

function prefixOf(p: DbConfigPattern): string {
  const names = Object.values(p.vars).filter(Boolean) as string[];
  if (p.kind === "url") {
    const v = names[0]!;
    if (/^(DATABASE_URL|DATABASE_URI|DB_URL|DB_URI|DB_CONNECTION_STRING|POSTGRES_URL|POSTGRESQL_URL|PG_URL|PG_CONNECTION_STRING|SQLALCHEMY_DATABASE_URI)$/.test(v)) return "";
    return v.replace(/_(DATABASE_URL|DATABASE_URI|DB_URL)$/, "");
  }
  // discrete: common prefix of all variable names minus the trailing part
  const host = p.vars.host ?? p.vars.name ?? names[0]!;
  const m = host.match(/^(.*?)(?:_?)(HOST|HOSTNAME|SERVER|NAME|DATABASE|DB)$/);
  const prefix = (m?.[1] ?? "").replace(/_$/, "");
  return PRIMARY_PREFIXES.has(prefix) ? "" : prefix.replace(/_(DB|DATABASE)$/, "");
}

export function groupSlots(patterns: DbConfigPattern[]): ConnectionSlot[] {
  const slots = new Map<string, ConnectionSlot>();
  for (const p of patterns) {
    const key = prefixOf(p);
    const s = slots.get(key) ?? {
      key,
      label: key ? `${titleCase(key)} database` : "Main database",
      patterns: [],
      primaryFamily: key === "",
    };
    s.patterns.push(p);
    slots.set(key, s);
  }
  return [...slots.values()].sort((a, b) => Number(b.primaryFamily) - Number(a.primaryFamily));
}

function describeSlot(s: ConnectionSlot): WiringChoice {
  const variables = s.patterns.flatMap((p) => Object.values(p.vars).filter(Boolean) as string[]);
  return { slotKey: s.key, label: `${s.label} (${variables.slice(0, 3).join(", ")}${variables.length > 3 ? ", …" : ""})`, variables };
}

/** Values for one pattern. Preserves driver-specific URL schemes and harmless query options from examples. */
export function envForPattern(p: DbConfigPattern, info: ConnectionInfo, env: EnvVarRequirement[]): Record<string, string> {
  const out: Record<string, string> = {};
  const v = p.vars;
  if (p.kind === "url" && v.url) {
    const example = env.find((e) => e.name === v.url)?.exampleValue ?? null;
    out[v.url] = adaptUrl(info, example);
    return out;
  }
  if (v.host) out[v.host] = info.host;
  if (v.port) out[v.port] = String(info.port);
  if (v.name) out[v.name] = info.database;
  if (v.user) out[v.user] = info.user;
  if (v.password) out[v.password] = info.password;
  if (v.ssl) out[v.ssl] = /SSLMODE/i.test(v.ssl) ? "disable" : "false";
  return out;
}

/**
 * Builds the connection URL in the style the app's example uses:
 *   postgresql+asyncpg://… (SQLAlchemy async), postgres://…, ?schema=public (Prisma) are kept;
 *   sslmode=require is turned off because the database is only reachable on this computer.
 */
export function adaptUrl(info: ConnectionInfo, example: string | null): string {
  let scheme = "postgresql";
  let query = "";
  if (example) {
    const m = example.match(/^(postgres(?:ql)?(?:\+\w+)?):\/\/[^?]*(\?.*)?$/i);
    if (m) {
      scheme = m[1]!.toLowerCase();
      if (m[2]) {
        const params = new URLSearchParams(m[2].slice(1));
        for (const k of [...params.keys()]) if (/^(sslmode|ssl|sslrootcert|sslcert|sslkey|user|password|host|port)$/i.test(k)) params.delete(k);
        const rest = params.toString();
        query = rest ? `?${rest}` : "";
      }
    }
  }
  const base = info.url.replace(/^postgresql:/, `${scheme}:`);
  return `${base}${query}`;
}

/**
 * Decides how to connect the app to its database without asking the user whenever possible.
 *  - one connection slot (possibly described several ways) → fill everything automatically;
 *  - a clear main slot plus others → fill the main one, report the others;
 *  - several slots and none is clearly main → ask one plain-language question;
 *  - no recognisable settings → set the conventional names and verify at startup.
 */
export function planDatabaseWiring(req: DatabaseRequirement, env: EnvVarRequirement[], info: ConnectionInfo, appName: string, chosenSlot?: string): WiringPlan {
  const slots = groupSlots(req.patterns);
  if (slots.length === 0) {
    return {
      status: "assumed",
      env: {
        DATABASE_URL: info.url,
        PGHOST: info.host,
        PGPORT: String(info.port),
        PGDATABASE: info.database,
        PGUSER: info.user,
        PGPASSWORD: info.password,
      },
      note: `${appName} doesn't name its database settings, so Nexus used the standard ones and will confirm the connection when it starts.`,
    };
  }
  let slot = chosenSlot !== undefined ? slots.find((s) => s.key === chosenSlot) : undefined;
  if (!slot) {
    const primary = slots.filter((s) => s.primaryFamily);
    if (slots.length === 1) slot = slots[0];
    else if (primary.length === 1) slot = primary[0];
    else {
      return {
        status: "ambiguous",
        question: `We found ${slots.length === 2 ? "two" : slots.length} possible database configurations. Which one does ${appName} use for its own data?`,
        choices: slots.map(describeSlot),
      };
    }
  }
  const out: Record<string, string> = {};
  for (const p of slot!.patterns) Object.assign(out, envForPattern(p, info, env));
  const unconnected = slots.filter((s) => s !== slot).map(describeSlot);
  return {
    status: "auto",
    env: out,
    slot: slot!.key,
    unconnected,
    note: unconnected.length
      ? `${appName} also has settings for ${unconnected.map((u) => u.label).join(" and ")}. You can connect ${unconnected.length > 1 ? "them" : "it"} later in Settings.`
      : `${appName} is connected to its database.`,
  };
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * MongoDB apps: every detected connection variable gets the app's own connection, whether it is a
 * URL (MONGODB_URI, MONGO_URL, DATABASE_URL…) or split into host/port/name/user/password.
 * All MongoDB patterns describe the same database, so there is never a question to ask.
 */
export function planDocumentWiring(req: DatabaseRequirement, info: ConnectionInfo): { env: Record<string, string>; note: string } {
  const env: Record<string, string> = {};
  for (const p of req.patterns) {
    const v = p.vars;
    if (p.kind === "url" && v.url) env[v.url] = info.url;
    if (p.kind === "discrete") {
      if (v.host) env[v.host] = info.host;
      if (v.port) env[v.port] = String(info.port);
      if (v.name) env[v.name] = info.database;
      if (v.user) env[v.user] = info.user;
      if (v.password) env[v.password] = info.password;
    }
  }
  const names = Object.keys(env);
  return { env, note: names.length ? `Document database connected through ${names.join(", ")}.` : "Document database ready." };
}
