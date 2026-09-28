import { afterEach, describe, expect, it, vi } from "vitest";
import { get, onAuthenticationRequired, post } from "../apps/ui/src/lib/api";

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message, problem: null } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("UI authentication lifecycle", () => {
  it("notifies the application shell when a protected request loses its session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(401, "unauthorized", "Please sign in.")));
    const listener = vi.fn();
    const unsubscribe = onAuthenticationRequired(listener);

    await expect(get("/apps")).rejects.toMatchObject({ status: 401, code: "unauthorized" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ status: 401, code: "unauthorized" });
    unsubscribe();
  });

  it("does not mistake rejected credentials for an expired session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(401, "unauthorized", "Wrong password.")));
    const listener = vi.fn();
    const unsubscribe = onAuthenticationRequired(listener);

    await expect(post("/auth/login", { username: "owner", password: "wrong" })).rejects.toMatchObject({ status: 401 });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not turn an ordinary permission denial into a sign-in prompt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(403, "forbidden", "Not allowed.")));
    const listener = vi.fn();
    const unsubscribe = onAuthenticationRequired(listener);

    await expect(get("/settings")).rejects.toMatchObject({ status: 403, code: "forbidden" });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
