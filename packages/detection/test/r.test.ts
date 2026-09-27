import { describe, expect, it } from "vitest";
import { analyzeProject, parseRenvLock, rPackagesInSource } from "@nexus/detection";
import { chooseR } from "@nexus/deployment";
import { resolveCommand, rPackagesScript, substituteArgs } from "@nexus/runtime";
import { project } from "./helpers";

describe("R Shiny applications", () => {
  it("finds the packages an app uses, ignoring comments", () => {
    expect(rPackagesInSource(`library(shiny)\nrequire("DT")\n# library(ignored)\nx <- dplyr::filter(df)\npacman::p_load(ggplot2, "leaflet")`)).toEqual(["DT", "dplyr", "ggplot2", "leaflet", "pacman", "shiny"]);
  });

  it("reads renv.lock", () => {
    expect(parseRenvLock(JSON.stringify({ R: { Version: "4.4.1" }, Packages: { shiny: { Package: "shiny", Version: "1.9.1" } } }))).toEqual({ rVersion: "4.4.1", packages: { shiny: "1.9.1" } });
  });

  it("detects an app.R project and runs it with shiny::runApp on the Nexus port", () => {
    const a = analyzeProject(project({ "app.R": `library(shiny)\nlibrary(RPostgres)\ncon <- Sys.getenv("DATABASE_URL")\nshinyApp(ui, server)` }, "sales-dashboard"));
    expect(a.runtime).toBe("r");
    expect(a.summary).toBe("Shiny application");
    const c = a.components[0]!;
    expect(c).toMatchObject({ framework: "Shiny", role: "fullstack", packageManager: "cran", install: { command: "r-packages", args: ["install", "RPostgres", "shiny"] } });
    expect(substituteArgs(c.start!.args, { PORT: 8123 }).join(" ")).toContain("port = 8123L");
    expect(a.env.map((e) => e.name)).toContain("DATABASE_URL");
    expect(a.database).toMatchObject({ required: true, kind: "postgresql" });
    expect(a.warnings).toEqual([]);
  });

  it("detects ui.R + server.R apps and restores renv.lock versions", () => {
    const a = analyzeProject(
      project({
        "ui.R": "fluidPage()",
        "server.R": "function(input, output) {}",
        "renv.lock": JSON.stringify({ R: { Version: "4.3.2" }, Packages: { shiny: { Package: "shiny", Version: "1.8.0" } } }),
        "renv/library/R-4.3/x86_64-w64-mingw32/shiny/DESCRIPTION": "Package: shiny",
      }),
    );
    const c = a.components[0]!;
    expect(c).toMatchObject({ runtime: "r", packageManager: "renv", runtimeVersion: "4.3.2", install: { args: ["restore", "renv.lock", "shiny"] } });
  });

  it("runs R with the release's own library and never a project .Rprofile", () => {
    const ctx = { nodeExe: "C:\\nexus\\node\\node.exe", rscript: "C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe", rLibDir: "C:\\apps\\x\\releases\\1\\.rlib" };
    const run = resolveCommand("Rscript", ["-e", "1"], ctx);
    expect(run.executable).toBe(ctx.rscript);
    expect(run.args).toEqual(["--no-save", "--no-restore", "--no-init-file", "-e", "1"]);
    expect(run.env.R_LIBS_USER).toBe(ctx.rLibDir);
    const install = resolveCommand("r-packages", ["install", "shiny"], ctx);
    expect(install.args.at(-1)).toContain("'shiny'");
    expect(() => resolveCommand("Rscript", [], { nodeExe: "node.exe" })).toThrow(/no environment/);
  });

  it("never puts double quotes in generated R code (Rscript re-quotes -e on Windows)", () => {
    expect(rPackagesScript(["restore", "renv.lock", "shiny", "bad;name"])).not.toContain('"');
    expect(rPackagesScript(["install", "shiny", "bad;name"])).not.toContain("bad;name");
  });

  it("chooses the R version the app was written for, or the closest", () => {
    const installs = ["4.5.1", "4.4.2", "4.3.3"].map((version) => ({ version, home: version, rscript: version }));
    expect(chooseR(installs, null)?.version).toBe("4.5.1");
    expect(chooseR(installs, "4.4.1")?.version).toBe("4.4.2");
    expect(chooseR(installs, "4.3.3")?.version).toBe("4.3.3");
    expect(chooseR(installs, "3.6.0")?.version).toBe("4.5.1");
    expect(chooseR([], "4.4.1")).toBeNull();
  });
});
