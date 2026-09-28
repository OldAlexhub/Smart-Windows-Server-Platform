import { describe, expect, it } from "vitest";
import { analyzeProject, categorizeEnv, parseDotenv } from "@nexus/detection";
import { project } from "./helpers";

const expressPkg = (deps: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  name: "taxiops",
  scripts: { start: "node server.js" },
  dependencies: { express: "4", ...deps },
  ...extra,
});

describe("environment variables", () => {
  it("parses dotenv syntax", () => {
    const m = parseDotenv(`# c\nexport A=1\nB="two words"\nC='x' \nD=val # comment\nbad line\n`);
    expect([...m]).toEqual([
      ["A", "1"],
      ["B", "two words"],
      ["C", "x"],
      ["D", "val"],
    ]);
  });

  it("categorizes variables", () => {
    expect(categorizeEnv("DATABASE_URL")).toBe("database");
    expect(categorizeEnv("PGHOST")).toBe("database");
    expect(categorizeEnv("PORT")).toBe("port");
    expect(categorizeEnv("UPLOAD_DIR")).toBe("storage");
    expect(categorizeEnv("STRIPE_API_KEY")).toBe("secret");
    expect(categorizeEnv("FRONTEND_URL")).toBe("url");
    expect(categorizeEnv("COMPANY_NAME")).toBe("config");
  });

  it("collects variables from examples, real .env (names only) and code", () => {
    const a = analyzeProject(
      project({
        "package.json": expressPkg({ pg: "8" }),
        ".env.example": "DATABASE_URL=postgres://user:pass@localhost:5432/taxiops\nJWT_SECRET=change-me\nSTRIPE_API_KEY=\n",
        ".env": "DATABASE_URL=postgres://real:REALSECRET@prod/db\nMAPBOX_TOKEN=pk.live\n",
        "server.js": "const { REPORT_EMAIL, PORT } = process.env;\nconst u = process.env['UPLOAD_DIR'];\napp.listen(process.env.PORT || 4000)",
      }),
    );
    const byName = Object.fromEntries(a.env.map((e) => [e.name, e]));
    expect(Object.keys(byName)).toEqual(["DATABASE_URL", "JWT_SECRET", "MAPBOX_TOKEN", "PORT", "REPORT_EMAIL", "STRIPE_API_KEY", "UPLOAD_DIR"]);
    expect(byName.DATABASE_URL).toMatchObject({ category: "database", managed: true, exampleValue: "postgres://user:pass@localhost:5432/taxiops" });
    expect(byName.MAPBOX_TOKEN!.exampleValue).toBeNull(); // real .env values are never read into the analysis
    expect(JSON.stringify(a)).not.toContain("REALSECRET");
    expect(byName.JWT_SECRET).toMatchObject({ category: "secret", managed: true }); // Nexus generates it
    expect(byName.STRIPE_API_KEY).toMatchObject({ category: "secret", managed: false }); // user must supply
    expect(byName.UPLOAD_DIR).toMatchObject({ category: "storage", managed: true });
  });

  it("reads Python os.environ / getenv", () => {
    const a = analyzeProject(
      project({
        "requirements.txt": "flask\npsycopg2-binary\n",
        "app.py": "import os\nfrom flask import Flask\napp = Flask(__name__)\nDB = os.environ['DB_HOST']\nx = os.getenv('DB_NAME')\ny = os.environ.get('DB_USER')\nz = os.environ.get('DB_PASSWORD')\n",
      }),
    );
    expect(a.env.map((e) => e.name)).toEqual(["DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_USER"]);
  });

  it("uses the Node startup import graph and finds explicit required settings", () => {
    const a = analyzeProject(
      project({
        "package.json": expressPkg(),
        ".env.example": "MONGO_URL=mongodb://localhost/app\nCLIENT_URL=http://localhost:3000\nTRUST_PROXY=false\n",
        "server.js": 'import "./config/environment.js";\napp.listen(3000);',
        "config/environment.js": `
          const client = process.env.CLIENT_URL;
          const trust = process.env.TRUST_PROXY;
          if (!client) throw new Error("CLIENT_URL is required when NODE_ENV=production.");
          if (!trust) throw new Error("TRUST_PROXY is required when NODE_ENV=production.");
        `,
        "controllers/report.js": `if (!req.body.cap) throw new Error("CAP is required");`,
        "scripts/maintenance/createAdmin.js": "const password = process.env.ADMIN_PASSWORD;",
      }),
    );
    expect(a.env.find((item) => item.name === "CLIENT_URL")).toMatchObject({ required: true, category: "url" });
    expect(a.env.find((item) => item.name === "TRUST_PROXY")).toMatchObject({ required: true, category: "config" });
    expect(a.env.some((item) => item.name === "ADMIN_PASSWORD")).toBe(false);
    expect(a.env.some((item) => item.name === "CAP")).toBe(false);
  });
});

describe("database detection", () => {
  it("TaxiOps: pg + DATABASE_URL → PostgreSQL via URL pattern", () => {
    const a = analyzeProject(
      project({
        "package.json": expressPkg({ pg: "8" }),
        "server.js": "const pool = new Pool({ connectionString: process.env.DATABASE_URL });",
      }),
    );
    expect(a.database).toMatchObject({ required: true, kind: "postgresql", libraries: ["pg"] });
    expect(a.database.patterns[0]).toMatchObject({ kind: "url", vars: { url: "DATABASE_URL" } });
    expect(a.database.evidence).toContain("Uses pg");
  });

  it("discrete DB_* variables are grouped into one configuration", () => {
    const a = analyzeProject(
      project({
        "package.json": expressPkg({ pg: "8" }),
        "db.js": "new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD })",
        "server.js": "",
      }),
    );
    expect(a.database.patterns).toHaveLength(1);
    expect(a.database.patterns[0]).toMatchObject({
      kind: "discrete",
      vars: { host: "DB_HOST", port: "DB_PORT", name: "DB_NAME", user: "DB_USER", password: "DB_PASSWORD" },
    });
  });

  it("reports two candidate configurations when both styles exist (ambiguity)", () => {
    const a = analyzeProject(
      project({
        "package.json": expressPkg({ pg: "8" }),
        ".env.example": "DATABASE_URL=\nPOSTGRES_HOST=\nPOSTGRES_DB=\nPOSTGRES_USER=\nPOSTGRES_PASSWORD=\n",
        "server.js": "",
      }),
    );
    expect(a.database.patterns.map((p) => p.kind)).toEqual(["url", "discrete"]);
    expect(a.database.patterns[1]!.vars).toEqual({
      host: "POSTGRES_HOST",
      name: "POSTGRES_DB",
      user: "POSTGRES_USER",
      password: "POSTGRES_PASSWORD",
    });
  });

  it("node-postgres with no configuration falls back to PG* variables", () => {
    const a = analyzeProject(project({ "package.json": expressPkg({ pg: "8" }), "server.js": "const pool = new Pool();" }));
    expect(a.database.patterns[0]!.vars.host).toBe("PGHOST");
  });

  it("uses the Prisma schema provider", () => {
    const a = analyzeProject(
      project({
        "package.json": expressPkg({ "@prisma/client": "5" }, { devDependencies: { prisma: "5" } }),
        "prisma/schema.prisma": 'generator client { provider = "prisma-client-js" }\ndatasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}',
        "prisma/migrations/20240101_init/migration.sql": "CREATE TABLE x();",
        "server.js": "",
      }),
    );
    expect(a.database.kind).toBe("postgresql");
    expect(a.migrations).toMatchObject({ tool: "prisma", autoRunnable: true, command: { args: ["prisma", "migrate", "deploy"] } });
  });

  it("flags MySQL apps with a friendly note", () => {
    const a = analyzeProject(project({ "package.json": expressPkg({ mysql2: "3" }), "server.js": "" }));
    expect(a.database.kind).toBe("mysql");
    expect(a.warnings.some((w) => w.includes("MySQL"))).toBe(true);
  });

  it("recognises MongoDB apps and the variables they read their connection from", () => {
    const a = analyzeProject(
      project({ "package.json": expressPkg({ mongoose: "8" }), "server.js": "mongoose.connect(process.env.MONGO_URI);", ".env.example": "MONGO_URI=mongodb://localhost:27017/shop\n" }),
    );
    expect(a.database).toMatchObject({ required: true, kind: "mongodb" });
    expect(a.database.patterns[0]).toMatchObject({ kind: "url", vars: { url: "MONGO_URI" } });
    expect(a.warnings.some((w) => w.includes("MongoDB"))).toBe(false);
  });

  it("gives MongoDB apps without visible settings the common variable names", () => {
    const a = analyzeProject(project({ "requirements.txt": "flask\npymongo\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" }));
    expect(a.database.kind).toBe("mongodb");
    expect(a.database.patterns.map((p) => p.vars.url)).toEqual(["MONGODB_URI", "MONGO_URL", "MONGO_URI"]);
  });

  it("uses DATABASE_URL for MongoDB when its example is a mongodb:// address", () => {
    const a = analyzeProject(
      project({ "package.json": expressPkg({ mongodb: "6" }), "server.js": "new MongoClient(process.env.DATABASE_URL)", ".env.example": "DATABASE_URL=mongodb://localhost/app\n" }),
    );
    expect(a.database.patterns.map((p) => p.vars.url)).toEqual(["DATABASE_URL"]);
  });

  it("detects MongoDB transaction requirements from application code", () => {
    const a = analyzeProject(
      project({
        "package.json": expressPkg({ mongoose: "8" }),
        "server.js": "mongoose.connect(process.env.MONGO_URL); await mongoose.connection.transaction(async (session) => run(session));",
      }),
    );
    expect(a.database).toMatchObject({ kind: "mongodb", transactions: true });
    expect(a.database.evidence).toContain("Uses MongoDB transactions (server.js)");
  });

  it("no database needed for a plain static site or DB-free API", () => {
    expect(analyzeProject(project({ "package.json": expressPkg(), "server.js": "" })).database.required).toBe(false);
  });
});

describe("storage, port, health, migrations", () => {
  it("detects uploads", () => {
    const a = analyzeProject(project({ "package.json": expressPkg({ multer: "1" }), "server.js": "app.post('/x', upload.single('f'))" }));
    expect(a.storage.required).toBe(true);
    expect(a.storage.evidence).toContain("Handles file uploads (multer)");
  });

  it("port read from env with default", () => {
    const a = analyzeProject(project({ "package.json": expressPkg(), "server.js": "const PORT = process.env.PORT || 5050; app.listen(PORT)" }));
    expect(a.port).toEqual({ value: 5050, envVar: "PORT", evidence: "server.js" });
  });

  it("warns about hard-coded ports", () => {
    const a = analyzeProject(project({ "package.json": expressPkg(), "server.js": "app.listen(8080, () => {})" }));
    expect(a.port).toMatchObject({ value: 8080, envVar: null });
    expect(a.warnings.some((w) => w.includes("port 8080"))).toBe(true);
  });

  it("uvicorn apps take the port Nexus gives them", () => {
    const a = analyzeProject(project({ "requirements.txt": "fastapi", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n" }));
    expect(a.port.envVar).toBe("PORT");
  });

  it("finds health endpoints in Express and FastAPI", () => {
    const e = analyzeProject(project({ "package.json": expressPkg(), "server.js": "app.get('/api/health', (req,res)=>res.json({ok:true}))" }));
    expect(e.health).toMatchObject({ mode: "automatic", candidate: { path: "/api/health", evidence: "Express route in server.js" }, endpoint: null });
    const f = analyzeProject(
      project({ "requirements.txt": "fastapi", "main.py": 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/healthz")\ndef h(): pass\n' }),
    );
    expect(f.health.candidate).toEqual({ path: "/healthz", evidence: "FastAPI route in main.py" });
    expect(analyzeProject(project({ "package.json": expressPkg(), "server.js": "" })).health.candidate).toBeNull();
  });

  it("does not infer health routes from comments, client calls, documentation, or tests", () => {
    const a = analyzeProject(project({
      "package.json": expressPkg(),
      "server.js": "// app.get('/health', handler)\nconst result = await axios.get('/health');\napp.listen(process.env.PORT)",
      "README.md": "Call GET /health",
      "server.test.js": "app.get('/health', handler)",
    }));
    expect(a.health.candidate).toBeNull();
  });

  it("prefers the app's own migrate script", () => {
    const a = analyzeProject(
      project({
        "package.json": expressPkg({ pg: "8", knex: "3" }, { scripts: { start: "node server.js", migrate: "knex migrate:latest" } }),
        "server.js": "",
      }),
    );
    expect(a.migrations).toMatchObject({ tool: "knex", command: { command: "npm", args: ["run", "migrate"] }, autoRunnable: true });
  });

  it("Django migrations and SQL schema files", () => {
    const d = analyzeProject(
      project({
        "requirements.txt": "django\npsycopg\n",
        "manage.py": "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'site1.settings')",
        "site1/settings.py": "DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql'}}",
      }),
    );
    expect(d.database.kind).toBe("postgresql");
    expect(d.migrations).toMatchObject({ tool: "django", autoRunnable: true });

    const s = analyzeProject(project({ "package.json": expressPkg({ pg: "8" }), "server.js": "", "db/schema.sql": "CREATE TABLE drivers();" }));
    expect(s.migrations).toMatchObject({ tool: "sql-files", autoRunnable: false, description: "Initialize schema from db/schema.sql" });
  });
});

describe("full TaxiOps-style analysis", () => {
  it("summarizes the spec example", () => {
    const a = analyzeProject(
      project(
        {
          "package.json": { name: "taxiops", private: true, scripts: { dev: "concurrently \"cd server && npm run dev\"" } },
          "server/package.json": { scripts: { start: "node index.js", migrate: "node-pg-migrate up" }, dependencies: { express: "4", pg: "8", multer: "1" }, devDependencies: { "node-pg-migrate": "7" } },
          "server/index.js": "app.get('/health', h); app.listen(process.env.PORT || 3001)",
          "server/.env.example": "DATABASE_URL=postgres://localhost/taxiops\nJWT_SECRET=\nSMTP_HOST=\nSMTP_USER=\nSMTP_PASSWORD=\nUPLOAD_DIR=./uploads\nFRONTEND_URL=\nGOOGLE_MAPS_KEY=\n",
          "client/package.json": { scripts: { build: "vite build" }, dependencies: { react: "19" }, devDependencies: { vite: "6" } },
        },
        "TaxiOps",
      ),
    );
    expect(a.summary).toBe("Node.js + Express backend, React frontend");
    expect(a.database.required).toBe(true);
    expect(a.database.kind).toBe("postgresql");
    expect(a.storage.required).toBe(true);
    expect(a.env).toHaveLength(9); // 8 in .env.example + PORT from code
    expect(a.health.candidate).toEqual({ path: "/health", evidence: "Express route in server/index.js" });
    expect(a.port).toMatchObject({ value: 3001, envVar: "PORT" });
    expect(a.migrations?.command).toEqual({ command: "npm", args: ["run", "migrate"] });
    expect(a.externalAccessRecommended).toBe(true);
  });
});
