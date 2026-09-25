import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject } from "@nexus/detection";
import { adaptUrl, groupSlots, planDatabaseWiring, type ConnectionInfo } from "@nexus/database";

const info: ConnectionInfo = {
  host: "127.0.0.1",
  port: 43500,
  database: "taxiops",
  user: "taxiops_taxiops",
  password: "Pw1234567890abcdefghijkLMNOPQRST",
  url: "postgresql://taxiops_taxiops:Pw1234567890abcdefghijkLMNOPQRST@127.0.0.1:43500/taxiops",
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function analyze(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "nexus-wire-"));
  dirs.push(root);
  for (const [rel, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), c);
  }
  return analyzeProject(root);
}
const pkg = (deps: Record<string, string> = { express: "4", pg: "8" }) => JSON.stringify({ scripts: { start: "node server.js" }, dependencies: deps });

describe("adaptUrl", () => {
  it("keeps driver schemes and harmless options, drops SSL and credentials", () => {
    expect(adaptUrl(info, null)).toBe(info.url);
    expect(adaptUrl(info, "postgres://u:p@localhost:5432/x")).toBe(info.url.replace("postgresql:", "postgres:"));
    expect(adaptUrl(info, "postgresql+asyncpg://u:p@db/x")).toMatch(/^postgresql\+asyncpg:\/\/taxiops_taxiops:/);
    expect(adaptUrl(info, "postgresql://u:p@db/x?schema=public&sslmode=require&connection_limit=5")).toBe(
      `${info.url}?schema=public&connection_limit=5`,
    );
  });
});

describe("planDatabaseWiring", () => {
  it("DATABASE_URL app (TaxiOps) → connected automatically", () => {
    const a = analyze({ "package.json": pkg(), "server.js": "new Pool({ connectionString: process.env.DATABASE_URL })" });
    const plan = planDatabaseWiring(a.database, a.env, info, "TaxiOps");
    expect(plan).toEqual({ status: "auto", env: { DATABASE_URL: info.url }, slot: "", unconnected: [], note: "TaxiOps is connected to its database." });
  });

  it("DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD → all populated", () => {
    const a = analyze({
      "package.json": pkg(),
      "server.js": "",
      ".env.example": "DB_HOST=localhost\nDB_PORT=5432\nDB_NAME=taxi\nDB_USER=postgres\nDB_PASSWORD=\nDB_SSL=true\n",
    });
    const plan = planDatabaseWiring(a.database, a.env, info, "TaxiOps");
    expect(plan.status).toBe("auto");
    expect(plan.status === "auto" && plan.env).toEqual({
      DB_HOST: "127.0.0.1",
      DB_PORT: "43500",
      DB_NAME: "taxiops",
      DB_USER: "taxiops_taxiops",
      DB_PASSWORD: info.password,
      DB_SSL: "false",
    });
  });

  it("both styles for the same database → fill both, no question", () => {
    const a = analyze({
      "package.json": pkg(),
      "server.js": "",
      ".env.example": "DATABASE_URL=postgres://localhost/taxi\nPOSTGRES_HOST=\nPOSTGRES_DB=\nPOSTGRES_USER=\nPOSTGRES_PASSWORD=\n",
    });
    const plan = planDatabaseWiring(a.database, a.env, info, "TaxiOps");
    expect(plan.status).toBe("auto");
    if (plan.status !== "auto") return;
    expect(Object.keys(plan.env).sort()).toEqual(["DATABASE_URL", "POSTGRES_DB", "POSTGRES_HOST", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
  });

  it("main database + a reporting database → connect main, mention the other", () => {
    const a = analyze({
      "package.json": pkg(),
      "server.js": "",
      ".env.example": "DATABASE_URL=postgres://localhost/taxi\nREPORTING_DATABASE_URL=postgres://warehouse/rep\n",
    });
    const plan = planDatabaseWiring(a.database, a.env, info, "TaxiOps");
    expect(plan.status).toBe("auto");
    if (plan.status !== "auto") return;
    expect(plan.env).toEqual({ DATABASE_URL: info.url.replace("postgresql:", "postgres:") });
    expect(plan.unconnected.map((u) => u.label)).toEqual(["Reporting database (REPORTING_DATABASE_URL)"]);
    expect(plan.note).toMatch(/also has settings for Reporting database/);
  });

  it("two unrelated connections and no obvious main one → asks one clear question", () => {
    const a = analyze({
      "package.json": pkg(),
      "server.js": "",
      ".env.example": "FLEET_DATABASE_URL=\nBILLING_DB_HOST=\nBILLING_DB_NAME=\nBILLING_DB_USER=\nBILLING_DB_PASSWORD=\n",
    });
    expect(groupSlots(a.database.patterns).map((s) => s.key).sort()).toEqual(["BILLING", "FLEET"]);
    const plan = planDatabaseWiring(a.database, a.env, info, "TaxiOps");
    expect(plan.status).toBe("ambiguous");
    if (plan.status !== "ambiguous") return;
    expect(plan.question).toBe("We found two possible database configurations. Which one does TaxiOps use for its own data?");
    expect(plan.choices.map((c) => c.slotKey).sort()).toEqual(["BILLING", "FLEET"]);

    const answered = planDatabaseWiring(a.database, a.env, info, "TaxiOps", "BILLING");
    expect(answered.status === "auto" && Object.keys(answered.env).sort()).toEqual(["BILLING_DB_HOST", "BILLING_DB_NAME", "BILLING_DB_PASSWORD", "BILLING_DB_USER"]);
  });

  it("Python SQLAlchemy async URL keeps its driver", () => {
    const a = analyze({
      "requirements.txt": "fastapi\nsqlalchemy\nasyncpg\n",
      "main.py": "from fastapi import FastAPI\nimport os\napp = FastAPI()\nurl = os.environ['DATABASE_URL']\n",
      ".env.example": "DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/fleet\n",
    });
    const plan = planDatabaseWiring(a.database, a.env, info, "Fleet");
    expect(plan.status === "auto" && plan.env.DATABASE_URL).toMatch(/^postgresql\+asyncpg:\/\/taxiops_taxiops:.+@127\.0\.0\.1:43500\/taxiops$/);
  });

  it("node-postgres with no settings → PG* variables", () => {
    const a = analyze({ "package.json": pkg(), "server.js": "const pool = new Pool();" });
    const plan = planDatabaseWiring(a.database, a.env, info, "TaxiOps");
    expect(plan.status === "auto" && plan.env).toMatchObject({ PGHOST: "127.0.0.1", PGDATABASE: "taxiops", PGUSER: "taxiops_taxiops" });
  });

  it("no recognisable settings → conventional names, verified at startup", () => {
    const plan = planDatabaseWiring({ required: true, kind: "unknown-sql", evidence: [], libraries: ["Sequelize"], patterns: [] }, [], info, "TaxiOps");
    expect(plan.status).toBe("assumed");
    expect(plan.status === "assumed" && plan.env.DATABASE_URL).toBe(info.url);
  });
});
