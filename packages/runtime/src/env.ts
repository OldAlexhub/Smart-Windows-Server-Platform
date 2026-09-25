import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** System variables an application genuinely needs on Windows. Everything else is dropped. */
const WINDOWS_ALLOWLIST = [
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS",
  "SystemDrive",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
];

export interface IsolatedEnvInput {
  /** App-private folder for HOME/TEMP/APPDATA so apps cannot read each other's caches. */
  homeDir: string;
  /** Extra directories to put first on PATH (managed runtimes, venv Scripts). */
  pathDirs: string[];
  /** Application variables (database, storage, secrets...). */
  appEnv: Record<string, string>;
  port: number;
  /** Source of system variables; defaults to process.env. */
  hostEnv?: NodeJS.ProcessEnv;
}

/**
 * Builds a clean environment: allow-listed system variables, private home/temp folders,
 * a minimal PATH, the assigned port, then the app's own configuration. Nexus's own
 * environment (and anything secret in it) never leaks into applications.
 */
export function buildIsolatedEnv(input: IsolatedEnvInput): Record<string, string> {
  const host = input.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const k of WINDOWS_ALLOWLIST) {
    const v = host[k];
    if (v !== undefined) env[k] = v;
  }
  const temp = join(input.homeDir, "tmp");
  const appData = join(input.homeDir, "AppData", "Roaming");
  const localAppData = join(input.homeDir, "AppData", "Local");
  for (const d of [temp, appData, localAppData]) mkdirSync(d, { recursive: true });

  const sysRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const systemPath = [join(sysRoot, "System32"), sysRoot, join(sysRoot, "System32", "Wbem")];

  Object.assign(env, {
    USERPROFILE: input.homeDir,
    HOME: input.homeDir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    PATH: [...input.pathDirs, ...systemPath].join(";"),
    PORT: String(input.port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  });
  // App configuration wins over defaults (e.g. an app that wants NODE_ENV=staging).
  for (const [k, v] of Object.entries(input.appEnv)) env[k] = v;
  // ...except the port and bind address, which Nexus owns.
  env.PORT = String(input.port);
  env.HOST = "127.0.0.1";
  return env;
}

/** Replaces {PORT} placeholders in command arguments. */
export function substituteArgs(args: string[], vars: { PORT: number }): string[] {
  return args.map((a) => a.replaceAll("{PORT}", String(vars.PORT)));
}
