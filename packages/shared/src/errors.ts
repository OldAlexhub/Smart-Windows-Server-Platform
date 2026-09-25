/**
 * Friendly-error model. Users never see only "ECONNREFUSED 127.0.0.1:5432";
 * every surfaced failure carries a plain-English problem, what Nexus checked,
 * an optional one-click repair, and technical details for Advanced mode.
 */
export type CheckStatus = "ok" | "failed" | "unknown" | "skipped";

export interface DiagnosticCheck {
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface RepairAction {
  /** Stable identifier the service knows how to execute, e.g. "database.repair-connection". */
  id: string;
  label: string;
  /** Whether this repair can change data or configuration (requires confirmation). */
  requiresConfirmation: boolean;
  params?: Record<string, string>;
}

export interface FriendlyProblem {
  title: string;
  summary: string;
  checks: DiagnosticCheck[];
  cause?: string;
  repair?: RepairAction;
  /** Raw technical detail; shown only under "Advanced Details". */
  technical?: string;
}

export type ErrorCode =
  | "not_found"
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "dependency_missing"
  | "infrastructure"
  | "internal";

const HTTP_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  rate_limited: 429,
  dependency_missing: 424,
  infrastructure: 503,
  internal: 500,
};

export class NexusError extends Error {
  readonly code: ErrorCode;
  readonly problem: FriendlyProblem | undefined;

  constructor(code: ErrorCode, message: string, options?: { problem?: FriendlyProblem; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "NexusError";
    this.code = code;
    this.problem = options?.problem;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  static notFound(what: string): NexusError {
    return new NexusError("not_found", `${what} was not found.`);
  }
  static invalid(message: string): NexusError {
    return new NexusError("invalid_input", message);
  }
  static forbidden(message = "You do not have permission to do that."): NexusError {
    return new NexusError("forbidden", message);
  }
  static unauthorized(message = "Please sign in."): NexusError {
    return new NexusError("unauthorized", message);
  }
  static conflict(message: string): NexusError {
    return new NexusError("conflict", message);
  }
}

export function isNexusError(e: unknown): e is NexusError {
  return e instanceof NexusError;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
