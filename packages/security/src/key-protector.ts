import { spawnSync } from "node:child_process";

/**
 * Wraps the vault master key at rest. On Windows the default is DPAPI, which binds
 * the key to the account running the Nexus service (LocalSystem in production), so
 * copying the key file to another machine or account does not reveal it.
 */
export interface KeyProtector {
  readonly kind: string;
  protect(data: Buffer): Buffer;
  unprotect(data: Buffer): Buffer;
}

export type DpapiScope = "CurrentUser" | "LocalMachine";

const PS_SCRIPT = (op: "Protect" | "Unprotect", scope: DpapiScope) =>
  [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$in=[Console]::In.ReadToEnd().Trim()",
    "$bytes=[Convert]::FromBase64String($in)",
    "$entropy=[Text.Encoding]::UTF8.GetBytes('nexus-master-key-v1')",
    `$out=[Security.Cryptography.ProtectedData]::${op}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::${scope})`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join(";");

export class DpapiKeyProtector implements KeyProtector {
  readonly kind = "dpapi";
  constructor(private readonly scope: DpapiScope = "CurrentUser") {}

  protect(data: Buffer): Buffer {
    return this.invoke("Protect", data);
  }

  unprotect(data: Buffer): Buffer {
    return this.invoke("Unprotect", data);
  }

  private invoke(op: "Protect" | "Unprotect", data: Buffer): Buffer {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT(op, this.scope)], {
      input: data.toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    if (r.status !== 0 || !r.stdout) {
      throw new Error(`Windows data protection failed (${op}): ${(r.stderr || r.error?.message || "").trim()}`);
    }
    return Buffer.from(r.stdout.trim(), "base64");
  }
}

/**
 * No-op protector. Only for tests and non-Windows development; the key file then relies
 * solely on filesystem permissions.
 */
export class InsecurePlainKeyProtector implements KeyProtector {
  readonly kind = "plain";
  protect(data: Buffer): Buffer {
    return Buffer.from(data);
  }
  unprotect(data: Buffer): Buffer {
    return Buffer.from(data);
  }
}

export function defaultKeyProtector(): KeyProtector {
  return process.platform === "win32" ? new DpapiKeyProtector() : new InsecurePlainKeyProtector();
}
