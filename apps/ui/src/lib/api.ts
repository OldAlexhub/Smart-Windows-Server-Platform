import type { FriendlyProblem } from "@nexus/shared/errors";

/** Error from the Nexus API, carrying the plain-language problem when there is one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly problem: FriendlyProblem | null,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type AuthenticationRequiredListener = (error: ApiError) => void;
const authenticationRequiredListeners = new Set<AuthenticationRequiredListener>();
const SIGN_IN_PATHS = new Set(["/auth/local", "/auth/login", "/auth/mfa"]);

/** Lets the application shell replace protected screens when a session has ended. */
export function onAuthenticationRequired(listener: AuthenticationRequiredListener): () => void {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

/** All requests carry the CSRF header; cookies carry the session. */
export async function api<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "x-nexus-request": "1",
      ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (data as { error?: { message?: string; code?: string; problem?: FriendlyProblem | null } } | null)?.error;
    const error = new ApiError(
      e?.message ?? `Request failed (${res.status})`,
      res.status,
      e?.code ?? "internal",
      e?.problem ?? null,
    );
    // Authentication attempts legitimately return 401 for incorrect credentials. Every other
    // 401 means the management session is no longer usable, regardless of which screen noticed it.
    if (res.status === 401 && !SIGN_IN_PATHS.has(path)) {
      for (const listener of authenticationRequiredListeners) listener(error);
    }
    throw error;
  }
  return data as T;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const get = <T>(p: string) => api<T>("GET", p);
export const post = <T>(p: string, b?: unknown) => api<T>("POST", p, b ?? {});
export const put = <T>(p: string, b?: unknown) => api<T>("PUT", p, b ?? {});
export const patch = <T>(p: string, b?: unknown) => api<T>("PATCH", p, b ?? {});
export const del = <T>(p: string, b?: unknown) => api<T>("DELETE", p, b ?? {});
