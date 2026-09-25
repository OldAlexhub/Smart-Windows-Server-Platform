import { describe, expect, it } from "vitest";
import { analyzeProject, parsePipfile, parsePyproject, parseRequirements } from "@nexus/detection";
import { project } from "./helpers";

describe("Python dependency files", () => {
  it("parses requirements.txt", () => {
    expect(
      parseRequirements("Flask[async]>=3.0 ; python_version>'3.8'\n# comment\n-r base.txt\npsycopg2_binary==2.9\ngit+https://x/y\n\nSQLAlchemy"),
    ).toEqual(["flask", "psycopg2-binary", "sqlalchemy"]);
  });

  it("parses PEP 621 and Poetry pyproject files", () => {
    expect(
      parsePyproject(`[project]\nname = "fleet-api"\nrequires-python = ">=3.11"\ndependencies = [\n  "fastapi>=0.110",\n  "asyncpg",\n]\n`),
    ).toEqual({ dependencies: ["fastapi", "asyncpg"], requiresPython: ">=3.11", name: "fleet-api" });
    const poetry = parsePyproject(
      `[tool.poetry]\nname = "reports"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nflask = "^3.0"\npsycopg = {version="^3", extras=["binary"]}\n\n[build-system]\nrequires = ["poetry-core"]\n`,
    );
    expect(poetry.dependencies).toEqual(["flask", "psycopg"]);
    expect(poetry.requiresPython).toBe("^3.12");
  });

  it("parses Pipfile packages", () => {
    expect(parsePipfile(`[[source]]\nurl = "x"\n\n[packages]\nrequests = "*"\n"django" = ">=5"\n\n[dev-packages]\npytest = "*"\n`)).toEqual([
      "requests",
      "django",
    ]);
  });
});

describe("Python detection", () => {
  it("FastAPI app → uvicorn on the Nexus-assigned port", () => {
    const a = analyzeProject(
      project({
        "requirements.txt": "fastapi\nuvicorn[standard]\npsycopg[binary]\n",
        "app/__init__.py": "",
        "app/main.py": "from fastapi import FastAPI\n\napp = FastAPI(title='Fleet')\n\n@app.get('/health')\ndef h(): return {}\n",
        ".python-version": "3.12\n",
      }),
    );
    expect(a.runtime).toBe("python");
    expect(a.summary).toBe("Python + FastAPI backend");
    expect(a.components[0]).toMatchObject({
      framework: "FastAPI",
      packageManager: "pip",
      install: { command: "pip", args: ["install", "-r", "requirements.txt"] },
      start: { command: "python", args: ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "{PORT}"] },
      entryFile: "app/main.py",
      runtimeVersion: "3.12",
      extraPackages: [],
    });
  });

  it("Flask app → waitress (Windows-compatible) and adds it when missing", () => {
    const a = analyzeProject(
      project({
        "requirements.txt": "Flask>=3\n",
        "app.py": "from flask import Flask\napp = Flask(__name__)\n",
      }),
    );
    expect(a.components[0]).toMatchObject({
      framework: "Flask",
      start: { command: "python", args: ["-m", "waitress", "--listen=127.0.0.1:{PORT}", "app:app"] },
      extraPackages: ["waitress"],
    });
  });

  it("Flask application factory in a src layout", () => {
    const a = analyzeProject(
      project({
        "pyproject.toml": `[project]\nname = "billing"\ndependencies = ["flask", "waitress"]\n[build-system]\nrequires=["hatchling"]\n`,
        "src/billing/__init__.py": "from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n",
      }),
    );
    expect(a.name).toBe("Billing");
    expect(a.components[0]).toMatchObject({
      install: { command: "pip", args: ["install", "."] },
      start: {
        command: "python",
        args: ["-m", "waitress", "--listen=127.0.0.1:{PORT}", "--call", "billing:create_app"],
        env: { PYTHONPATH: "src" },
      },
      extraPackages: [],
    });
  });

  it("Django project → WSGI via waitress", () => {
    const a = analyzeProject(
      project({
        "requirements.txt": "Django>=5\npsycopg2-binary\n",
        "manage.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')\n",
        "mysite/settings.py": "",
        "mysite/wsgi.py": "",
      }),
    );
    expect(a.components[0]).toMatchObject({
      framework: "Django",
      start: { command: "python", args: ["-m", "waitress", "--listen=127.0.0.1:{PORT}", "mysite.wsgi:application"] },
    });
  });

  it("plain Python service", () => {
    const a = analyzeProject(project({ "main.py": "print('hi')", "requirements.txt": "requests" }));
    expect(a.components[0]).toMatchObject({ framework: "Python", start: { command: "python", args: ["main.py"] } });
    expect(a.summary).toBe("Python backend");
  });

  it("Python API in backend/ with a React frontend in frontend/", () => {
    const a = analyzeProject(
      project({
        "backend/requirements.txt": "fastapi\n",
        "backend/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
        "frontend/package.json": { scripts: { build: "vite build" }, dependencies: { react: "19" }, devDependencies: { vite: "6" } },
      }),
    );
    expect(a.summary).toBe("Python + FastAPI backend, React frontend");
    expect(a.runtime).toBe("python");
    expect(a.components[0]!.start!.args).toContain("main:app");
  });

  it("does not mistake a Node project with a helper script for Python", () => {
    const a = analyzeProject(
      project({ "package.json": { main: "index.js", dependencies: { express: "4" } }, "index.js": "", "scripts/seed.py": "" }),
    );
    expect(a.runtime).toBe("node");
  });
});
