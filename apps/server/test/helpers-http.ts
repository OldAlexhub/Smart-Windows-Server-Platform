import type { FastifyInstance } from "fastify";
import type { NexusContext } from "../src/context";

export const CSRF = { "x-nexus-request": "1" };

/** Signs in as the local Owner (what the desktop app does) and returns a request helper. */
export async function ownerClient(app: FastifyInstance, ctx: NexusContext) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/local", headers: CSRF, payload: { token: ctx.localToken } });
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  return async function call<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown): Promise<{ status: number; body: T }> {
    const r = await app.inject({ method, url, headers: { cookie, ...CSRF }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body ? (r.json() as T) : (undefined as T) };
  };
}
