import { describe, expect, it } from "vitest";
import { explainError } from "@nexus/logs";

const ctx = { appName: "TaxiOps", databasePort: 43500, databaseRunning: true, credentialsValid: true };

describe("explainError", () => {
  it("spec example: ECONNREFUSED 127.0.0.1:5432 while Nexus DB runs elsewhere → outdated configuration", () => {
    const p = explainError("Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect", ctx);
    expect(p.title).toBe("Database Connection Problem");
    expect(p.summary).toBe("TaxiOps cannot currently connect to its database.");
    expect(p.checks).toEqual([
      { label: "Database server", status: "ok", detail: "Running" },
      { label: "Network", status: "ok", detail: "Working" },
      { label: "Credentials", status: "ok", detail: "Working" },
    ]);
    expect(p.cause).toBe("TaxiOps is using an outdated database configuration.");
    expect(p.repair).toMatchObject({ id: "database.repair-connection", label: "Repair Connection", requiresConfirmation: false });
    expect(p.technical).toContain("ECONNREFUSED");
  });

  it("database stopped → offer to start it", () => {
    const p = explainError("psycopg2.OperationalError: connection to server at \"127.0.0.1\", port 43500 failed: Connection refused", {
      ...ctx,
      databaseRunning: false,
    });
    expect(p.cause).toBe("The database server is not running.");
    expect(p.repair?.id).toBe("database.start");
  });

  it("bad password, missing tables, missing database", () => {
    expect(explainError('FATAL: password authentication failed for user "taxiops"', ctx)).toMatchObject({
      title: "Database Sign-in Problem",
      repair: { id: "database.repair-connection" },
    });
    const tables = explainError('error: relation "drivers" does not exist', ctx);
    expect(tables.summary).toContain('"drivers"');
    expect(tables.repair).toMatchObject({ id: "app.run-migrations", requiresConfirmation: true });
    expect(explainError('FATAL: database "taxi" does not exist', ctx).title).toBe("Database Missing");
  });

  it("port conflicts, missing modules, memory, disk", () => {
    expect(explainError("Error: listen EADDRINUSE: address already in use 127.0.0.1:43127", ctx)).toMatchObject({
      title: "Port Conflict",
      repair: { id: "app.reassign-port" },
    });
    expect(explainError("Error: Cannot find module 'express'", ctx)).toMatchObject({
      title: "Missing Component",
      repair: { id: "app.reinstall" },
    });
    expect(explainError("Error: Cannot find module './routes/drivers'", ctx).title).toBe("Application File Missing");
    expect(explainError("ModuleNotFoundError: No module named 'pandas'", ctx).summary).toContain('"pandas"');
    expect(explainError("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", ctx).repair?.id).toBe(
      "app.raise-memory-limit",
    );
    expect(explainError("Error: ENOSPC: no space left on device, write", ctx).title).toBe("Drive Full");
  });

  it("missing business settings the user must provide", () => {
    const p = explainError("Error: Missing required environment variable: STRIPE_API_KEY", ctx);
    expect(p).toMatchObject({ title: "Setting Needed", repair: { id: "app.open-settings", params: { variable: "STRIPE_API_KEY" } } });
    expect(explainError("Invalid environment configuration:\n- CLIENT_URL is required when NODE_ENV=production.", ctx)).toMatchObject({
      title: "Setting Needed",
      repair: { id: "app.open-settings", params: { variable: "CLIENT_URL" } },
    });
    expect(explainError("KeyError: 'GOOGLE_MAPS_KEY'", ctx).summary).toContain("GOOGLE_MAPS_KEY");
  });

  it("code errors are never auto-fixed — offer rollback instead", () => {
    const p = explainError("TypeError: Cannot read properties of undefined (reading 'provider_id')\n    at x (a.js:1:1)", ctx);
    expect(p.title).toBe("Application Code Error");
    expect(p.cause).toMatch(/never edits your code/);
    expect(p.repair).toMatchObject({ id: "app.rollback", requiresConfirmation: true });
  });

  it("internet problems and unknown errors", () => {
    expect(explainError("getaddrinfo ENOTFOUND api.stripe.com", { ...ctx, internetAvailable: false })).toMatchObject({
      title: "Internet Service Unreachable",
      cause: "This computer is currently offline.",
    });
    const unknown = explainError("weird thing 42", ctx);
    expect(unknown).toMatchObject({ title: "Application Error", summary: "TaxiOps reported an error.", technical: "weird thing 42" });
  });
});
