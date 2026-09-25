import { describe, expect, it } from "vitest";
import { analyzeProject } from "@nexus/detection";
import { project } from "./helpers";

describe("Node.js detection", () => {
  it("detects an Express backend (TaxiOpsBackend)", () => {
    const root = project(
      {
        "package.json": {
          name: "taxiops-backend",
          main: "server.js",
          scripts: { start: "node server.js", dev: "nodemon server.js" },
          dependencies: { express: "^4.19.0", pg: "^8.11.0" },
          engines: { node: ">=20" },
        },
        "package-lock.json": "{}",
        "server.js": "const express = require('express'); const app = express(); app.listen(process.env.PORT || 3000);",
      },
      "TaxiOpsBackend",
    );
    const a = analyzeProject(root);
    expect(a.name).toBe("Taxiops Backend");
    expect(a.runtime).toBe("node");
    expect(a.summary).toBe("Node.js + Express backend");
    expect(a.components).toHaveLength(1);
    expect(a.components[0]).toMatchObject({
      role: "backend",
      framework: "Express",
      language: "javascript",
      packageManager: "npm",
      install: { command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
      start: { command: "npm", args: ["run", "start"] },
      entryFile: "server.js",
      runtimeVersion: ">=20",
    });
    expect(a.externalAccessRecommended).toBe(true);
    expect(a.warnings).toEqual([]);
  });

  it("uses the folder name when package.json has no usable name, keeping author casing", () => {
    const root = project({ "package.json": { dependencies: { express: "4" } }, "index.js": "" }, "TaxiOps");
    expect(analyzeProject(root).name).toBe("TaxiOps");
  });

  it("replaces nodemon start scripts with plain node and falls back to entry files", () => {
    const a = analyzeProject(
      project({ "package.json": { scripts: { start: "nodemon app.js" }, dependencies: { koa: "2" } }, "app.js": "" }),
    );
    expect(a.components[0]).toMatchObject({ framework: "Koa", start: { command: "node", args: ["app.js"] } });

    const b = analyzeProject(project({ "package.json": { dependencies: { fastify: "5" } }, "src/server.js": "" }));
    expect(b.components[0]).toMatchObject({ framework: "Fastify", start: { command: "node", args: ["src/server.js"] } });
  });

  it("detects TypeScript backends with a build step", () => {
    const a = analyzeProject(
      project({
        "package.json": {
          scripts: { build: "tsc", start: "node dist/index.js" },
          dependencies: { express: "4" },
          devDependencies: { typescript: "5" },
        },
        "tsconfig.json": "{}",
        "yarn.lock": "",
      }),
    );
    expect(a.components[0]).toMatchObject({
      language: "typescript",
      packageManager: "yarn",
      build: { command: "yarn", args: ["run", "build"] },
      start: { command: "yarn", args: ["run", "start"] },
    });
  });

  it("detects Next.js as a full-stack app", () => {
    const a = analyzeProject(
      project({
        "package.json": { scripts: { build: "next build", start: "next start" }, dependencies: { next: "15", react: "19" } },
      }),
    );
    expect(a.summary).toBe("Next.js application");
    expect(a.components[0]).toMatchObject({ role: "fullstack", build: { args: ["run", "build"] } });
  });

  it("detects a Vite React frontend and never runs its dev server", () => {
    const a = analyzeProject(
      project({
        "package.json": { scripts: { dev: "vite", start: "vite", build: "vite build" }, dependencies: { react: "19" }, devDependencies: { vite: "6" } },
        "index.html": "<div id=root>",
      }),
    );
    expect(a.components[0]).toMatchObject({ role: "frontend", framework: "React", start: null, staticDir: "dist" });
    expect(a.summary).toBe("React frontend");
  });

  it("detects Create React App output folder", () => {
    const a = analyzeProject(
      project({ "package.json": { scripts: { start: "react-scripts start", build: "react-scripts build" }, dependencies: { react: "18", "react-scripts": "5" } } }),
    );
    expect(a.components[0]).toMatchObject({ role: "frontend", staticDir: "build", start: null });
  });

  it("detects a backend + frontend project in server/ and client/ folders", () => {
    const a = analyzeProject(
      project({
        "package.json": { name: "taxiops", scripts: { dev: "concurrently \"cd server && npm run dev\" \"cd client && npm run dev\"" } },
        "server/package.json": { scripts: { start: "node index.js" }, dependencies: { express: "4", pg: "8" } },
        "server/index.js": "",
        "client/package.json": { scripts: { build: "vite build" }, dependencies: { react: "19" }, devDependencies: { vite: "6" } },
        "client/index.html": "",
      }),
    );
    expect(a.name).toBe("Taxiops");
    expect(a.components.map((c) => [c.role, c.path, c.framework])).toEqual([
      ["backend", "server", "Express"],
      ["frontend", "client", "React"],
    ]);
    expect(a.summary).toBe("Node.js + Express backend, React frontend");
    expect(a.components[1]!.staticDir).toBe("client/dist");
  });

  it("root Express app with a client/ React folder keeps both", () => {
    const a = analyzeProject(
      project({
        "package.json": { scripts: { start: "node server.js" }, dependencies: { express: "4" } },
        "server.js": "",
        "client/package.json": { scripts: { build: "react-scripts build" }, dependencies: { react: "18", "react-scripts": "5" } },
      }),
    );
    expect(a.components.map((c) => `${c.role}:${c.path || "."}`)).toEqual(["backend:.", "frontend:client"]);
  });

  it("detects plain static sites", () => {
    const a = analyzeProject(project({ "index.html": "<h1>hi</h1>", "style.css": "" }, "brochure"));
    expect(a.runtime).toBe("static");
    expect(a.summary).toBe("Static website");
    expect(a.components[0]!.staticDir).toBe("");
  });

  it("ignores node_modules and explains unrecognised folders", () => {
    const a = analyzeProject(project({ "node_modules/express/package.json": { name: "express" }, "notes.txt": "hello" }));
    expect(a.components).toEqual([]);
    expect(a.warnings[0]).toMatch(/couldn't recognise/);
  });

  it("warns when a backend has no start command", () => {
    const a = analyzeProject(project({ "package.json": { dependencies: { express: "4" } } }));
    expect(a.warnings.some((w) => /start this application/.test(w))).toBe(true);
  });

  it("notices Dockerfiles", () => {
    const a = analyzeProject(project({ "package.json": { main: "a.js", dependencies: {} }, "a.js": "", Dockerfile: "FROM node" }));
    expect(a.hasDockerfile).toBe(true);
  });
});
