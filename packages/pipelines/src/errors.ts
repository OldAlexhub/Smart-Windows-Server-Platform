import type { FriendlyProblem } from "@nexus/shared";

/**
 * A step failure. `transient` failures (network hiccups, a database restarting, rate limits) are
 * retried under the step's retry policy; permanent ones (a missing column, a script error, a bad
 * query) fail straight away — retrying them would only waste time.
 */
export class StepError extends Error {
  readonly transient: boolean;
  readonly problem: FriendlyProblem | undefined;
  readonly technical: string | undefined;

  constructor(message: string, opts: { transient?: boolean; problem?: FriendlyProblem; technical?: string; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "StepError";
    this.transient = opts.transient ?? false;
    this.problem = opts.problem;
    this.technical = opts.technical;
  }
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "57P01", "57P03", "53300", "08006", "08001", "08004"]);
const TRANSIENT_TEXT = /timed? ?out|temporar|connection (?:terminated|reset|refused)|too many (?:connections|requests)|server closed the connection|\b(?:429|502|503|504)\b|socket hang up|rate limit/i;

/** Decides whether an arbitrary error is worth retrying. */
export function isTransient(e: unknown): boolean {
  if (e instanceof StepError) return e.transient;
  const err = e as { code?: unknown; cause?: { code?: unknown }; message?: unknown; status?: unknown };
  if (typeof err?.code === "string" && TRANSIENT_CODES.has(err.code)) return true;
  if (typeof err?.cause?.code === "string" && TRANSIENT_CODES.has(err.cause.code)) return true;
  if (typeof err?.status === "number" && [408, 429, 502, 503, 504].includes(err.status)) return true;
  return typeof err?.message === "string" && TRANSIENT_TEXT.test(err.message);
}

/** Raised when a run is stopped by the user or exceeds its time limit. */
export class RunAborted extends Error {
  constructor(readonly reason: "cancelled" | "timeout") {
    super(reason === "cancelled" ? "The run was cancelled." : "The run took longer than its time limit and was stopped.");
    this.name = "RunAborted";
  }
}
