import { describe, expect, it } from "vitest";

const modulePath = "../scripts/service-settings.mjs";
const { readServiceSettings } = await import(modulePath);

describe("upgrade service settings", () => {
  it("preserves custom data locations and ports including XML-escaped paths", () => {
    expect(readServiceSettings('<service><env value="D:\\Apps &amp; Data" name="NEXUS_HOME"/><env name="NEXUS_PORT" value="8890"/></service>'))
      .toEqual({ home: "D:\\Apps & Data", port: 8890 });
  });
  it.each(["", '<env name="NEXUS_PORT" value="7780"/>', '<env name="NEXUS_HOME" value="D:\\Data"/><env name="NEXUS_PORT" value="NaN"/>'])("never silently resets broken existing settings", (xml) => {
    expect(() => readServiceSettings(xml)).toThrow(/Refusing/);
  });
});
