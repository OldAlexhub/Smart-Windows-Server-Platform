import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureStepEnvironment, PIPELINE_RUNTIME_VERSIONS } from "@nexus/pipelines";

describe("pipeline reproducibility environment", () => {
  it("keeps captured engine versions aligned with the shipped package", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
    };
    expect(PIPELINE_RUNTIME_VERSIONS).toEqual({ pipelines: pkg.version, duckdb: pkg.dependencies["@duckdb/node-api"] });
  });

  it("combines an exact script environment with the host runtime without secrets", () => {
    const environment = captureStepEnvironment({
      runtime: "Python 3.12.4",
      packages: { pandas: "2.3.1", nexus: "0.1.0" },
    });
    expect(environment).toEqual({
      runtime: "Python 3.12.4",
      packages: { pandas: "2.3.1", nexus: "0.1.0" },
      host: {
        platform: process.platform,
        architecture: process.arch,
        node: process.versions.node,
        pipelines: PIPELINE_RUNTIME_VERSIONS.pipelines,
        duckdb: PIPELINE_RUNTIME_VERSIONS.duckdb,
      },
    });
    expect(JSON.stringify(environment)).not.toMatch(/secret|password|token/i);
  });
});
