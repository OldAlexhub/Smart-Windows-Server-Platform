export type EntryLevel = "error" | "warning" | "info";

const PINO_LEVELS: Record<number, EntryLevel> = { 10: "info", 20: "info", 30: "info", 40: "warning", 50: "error", 60: "error" };

/**
 * Decides whether a log line is an error, a warning or normal activity.
 * Understands JSON loggers (pino/winston/structlog), Python logging, and plain text.
 * Note: writing to stderr alone does NOT make a line an error — Python logs everything there.
 */
export function classifyLine(line: string): EntryLevel {
  const t = line.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const lvl = j.level ?? j.severity ?? j.levelname ?? j.lvl;
      if (typeof lvl === "number") return PINO_LEVELS[lvl] ?? (lvl >= 50 ? "error" : lvl >= 40 ? "warning" : "info");
      if (typeof lvl === "string") return fromWord(lvl) ?? "info";
    } catch {
      /* not JSON */
    }
  }
  // "2026-09-23 10:00:01,123 - app - ERROR - ...", "ERROR:root:...", "[WARN] ...", "level=error"
  const tagged = t.match(/(?:^|[\s[(|:-])(CRITICAL|FATAL|ERROR|ERR|WARNING|WARN|INFO|DEBUG)(?:[\s\]):|-]|$)/);
  if (tagged) {
    const w = fromWord(tagged[1]!);
    if (w) return w;
  }
  const kv = t.match(/\blevel=(\w+)/i);
  if (kv) return fromWord(kv[1]!) ?? "info";
  if (/^Traceback \(most recent call last\)|^\w*(Error|Exception)(:|$)|Unhandled|uncaught|\bECONNREFUSED\b|\bEADDRINUSE\b|^\s*at .+\(.+:\d+:\d+\)$/i.test(t)) {
    return "error";
  }
  if (/^Invalid (?:environment )?configuration:?$|^-\s+[A-Z][A-Z0-9_]*\s+(?:is|are)\s+required\b/i.test(t)) return "error";
  if (/^(?:server|application|service)\s+(?:startup\s+)?failed[.!]?$/i.test(t)) return "error";
  if (/\b(deprecat\w*|warning)\b/i.test(t)) return "warning";
  return "info";
}

function fromWord(w: string): EntryLevel | null {
  const u = w.toUpperCase();
  if (["CRITICAL", "FATAL", "ERROR", "ERR", "EMERG", "ALERT", "CRIT"].includes(u)) return "error";
  if (["WARNING", "WARN"].includes(u)) return "warning";
  if (["INFO", "DEBUG", "TRACE", "NOTICE", "VERBOSE", "HTTP", "SILLY"].includes(u)) return "info";
  return null;
}

/** Lines that continue the previous entry (stack frames, tracebacks, wrapped output). */
export function isContinuation(line: string, previous: string | null): boolean {
  if (previous === null) return false;
  if (/^\s+at\s/.test(line)) return true; // JS stack frame
  if (/^\s+File ".+", line \d+/.test(line)) return true; // Python frame
  if (/^\s{2,}\S/.test(line) && /(Traceback|Error|Exception|File ")/.test(previous)) return true;
  if (/^(\w+\.)*\w*(Error|Exception)(:\s|$)/.test(line) && /^\s/.test(previous)) return true; // Python final "ValueError: ..."
  if (/^\s*\^+\s*$/.test(line)) return true; // caret markers
  if (/^\s*\}\s*$/.test(line) && /^\s/.test(previous)) return true;
  return false;
}

// ------------------------------------------------------------------ redaction

const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)([^@\s/]+)(@)/gi;
const KEY_VALUE_SECRET = /\b((?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)("?)([^\s"',;]+)\2/gi;

/** Masks credentials so logs are safe to show, export, or hand to the AI assistant. */
export class Redactor {
  private readonly secrets = new Set<string>();

  addSecret(value: string | undefined | null): void {
    if (value && value.length >= 6) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text.replace(URL_CREDENTIALS, "$1***$3").replace(KEY_VALUE_SECRET, "$1$2***$2");
    for (const s of this.secrets) if (out.includes(s)) out = out.split(s).join("***");
    return out;
  }
}
