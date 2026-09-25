/**
 * Nexus Core Service entry point.
 * Runs as a Windows service in production (via WinSW) or from a terminal in development.
 * The management API listens on 127.0.0.1 only; remote administration goes through the gateway.
 */
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { BRAND, consoleSink, createLogger, type LogRecord } from "@nexus/shared";
import { createNexusServer, startBackground } from "./app";
import { NexusContext } from "./context";
import { resolveServicePaths } from "./paths";
import { hardenDataFolder } from "./service/permissions";

// node:sqlite is stable in practice but still prints an experimental warning.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});

async function main(): Promise<void> {
  const port = Number(process.env.NEXUS_PORT ?? 7780);
  const paths = resolveServicePaths();
  const production = process.env.NODE_ENV === "production";
  // A log file that can't be written must never stop Nexus from starting: say so once, keep going.
  let logFileFailed = false;
  const fileSink = (r: LogRecord) => {
    try {
      appendFileSync(join(paths.logs, "nexus.log"), JSON.stringify(r) + "\n");
    } catch (e) {
      if (!logFileFailed) console.error(`${BRAND.productName} can't write its log file:`, (e as Error).message);
      logFileFailed = true;
    }
  };
  const log = createLogger({ level: process.env.NEXUS_LOG_LEVEL === "debug" ? "debug" : "info", sinks: production ? [fileSink] : [fileSink, consoleSink] });

  // As the Windows service (LocalSystem): only SYSTEM, Administrators and the installing user may
  // read the data folder. Done first, because it also repairs files whose permissions went wrong.
  // Skipped when run by hand, which would otherwise lock the runner out.
  if (production && userInfo().username.toUpperCase() === "SYSTEM") {
    mkdirSync(paths.root, { recursive: true });
    hardenDataFolder(paths.root, paths.localTokenFile, log);
  }
  log.info("starting", { product: BRAND.productName, home: paths.root, port, node: process.version });

  const ctx = await NexusContext.create({ paths, managementPort: port, logger: log });
  const { app, services } = await createNexusServer(ctx);
  await app.listen({ host: "127.0.0.1", port });
  log.info("listening", { url: `http://127.0.0.1:${port}` });
  if (!production) {
    // Development convenience: a one-click local sign-in link (the desktop app does this automatically).
    process.stdout.write(`\n  ${BRAND.productName} is running.\n  Open: http://127.0.0.1:${port}/?local=${ctx.localToken}\n\n`);
  }
  await startBackground(ctx, services);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal });
    const force = setTimeout(() => process.exit(1), 50_000);
    force.unref();
    try {
      await app.close();
      await ctx.shutdown();
    } finally {
      process.exit(0);
    }
  };
  for (const s of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(s, () => void shutdown(s));
  // Portable copy: "Stop Nexus" asks for a clean shutdown (apps and databases stopped first) by
  // creating this file; a hidden process can't be sent Ctrl+C.
  const stopFile = process.env.NEXUS_STOP_FILE;
  if (stopFile) {
    const poll = setInterval(() => {
      if (!existsSync(stopFile)) return;
      clearInterval(poll);
      rmSync(stopFile, { force: true });
      void shutdown("stop-file");
    }, 1000);
    poll.unref();
  }
}

main().catch((e) => {
  console.error(`${BRAND.productName} could not start:`, e);
  process.exit(1);
});
