import { describe, expect, it } from "vitest";
import { parseEnvUpload } from "../packages/shared/src/env-file";

describe("uploaded .env files", () => {
  it("supports UTF-8 BOM, CRLF, export, quotes, comments, empty and multiline values", () => {
    expect(parseEnvUpload('\uFEFF# comment\r\nexport NAME="two words" # comment\r\nEMPTY=\r\nSECRET=\'with#hash\'\r\nRAW=value # comment\nKEY="first\\nsecond"\nMULTILINE="first\nsecond"\nNAME=last')).toEqual({ NAME: "last", EMPTY: "", SECRET: "with#hash", RAW: "value", KEY: "first\nsecond", MULTILINE: "first\nsecond" });
  });
  it("never expands variables or executes commands", () => {
    expect(parseEnvUpload('A=${SECRET}\nB=$(whoami)')).toEqual({ A: "${SECRET}", B: "$(whoami)" });
    expect(Object.getPrototypeOf(parseEnvUpload("__proto__=value"))).toBeNull();
  });
  it("rejects invalid, oversized or binary files without leaking values", () => {
    for (const content of ['BAD secret-password', 'SECRET="secret-password', 'SECRET="secret-password" junk', 'A=secret-password\0', 'A=' + 'x'.repeat(16_385), 'A=' + 'x'.repeat(128 * 1024)]) {
      expect(() => parseEnvUpload(content)).toThrow();
      try { parseEnvUpload(content); } catch (error) { expect(String(error)).not.toContain("secret-password"); }
    }
    expect(() => parseEnvUpload("# empty")).toThrow("no settings");
  });
});
