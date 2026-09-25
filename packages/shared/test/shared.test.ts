import { describe, expect, it } from "vitest";
import {
  attempt,
  createLogger,
  formatBytes,
  formatDuration,
  memorySink,
  NexusError,
  randomToken,
  slugify,
  sqlIdentifier,
} from "@nexus/shared";

describe("ids", () => {
  it("slugifies names", () => {
    expect(slugify("TaxiOps Backend!")).toBe("taxiops-backend");
    expect(slugify("  Café  Déjà ")).toBe("cafe-deja");
    expect(slugify("!!!")).toBe("app");
  });
  it("creates safe SQL identifiers", () => {
    expect(sqlIdentifier("TaxiOps")).toBe("taxiops");
    expect(sqlIdentifier("2024 Finance")).toBe("n_2024_finance");
    expect(sqlIdentifier("drop table; --")).toBe("drop_table");
  });
  it("random tokens are unique and url-safe", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
});

describe("format", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(64 * 1024 ** 3)).toBe("64.0 GB");
  });
  it("formats durations", () => {
    expect(formatDuration(7000)).toBe("7s");
    expect(formatDuration(402_000)).toBe("6m 42s");
  });
});

describe("errors & result", () => {
  it("maps codes to http status", () => {
    expect(NexusError.notFound("App").httpStatus).toBe(404);
    expect(NexusError.forbidden().httpStatus).toBe(403);
  });
  it("attempt captures failures", async () => {
    const r = await attempt(async () => {
      throw new Error("boom");
    });
    expect(r.ok).toBe(false);
    expect(await attempt(async () => 5)).toEqual({ ok: true, value: 5 });
  });
});

describe("logger", () => {
  it("emits structured records with bindings and respects level", () => {
    const sink = memorySink();
    const log = createLogger({ level: "info", sinks: [sink] }).child({ module: "test" });
    log.debug("hidden");
    log.info("hello", { appId: "a1", err: new Error("x") });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ level: "info", msg: "hello", module: "test", appId: "a1" });
    expect((sink.records[0]!.err as { message: string }).message).toBe("x");
  });
});
