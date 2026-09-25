import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Abstraction over process execution so detection logic is testable with fixtures. */
export type CommandRunner = (command: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;

export const execRunner: CommandRunner = (command, args, timeoutMs = 60_000) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "buffer", timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve({ code, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0) });
      },
    );
  });

/** Windows tools (wsl.exe) sometimes print UTF-16LE; detect and decode either encoding. */
export function decodeConsole(buf: Buffer): string {
  if (buf.length >= 2 && buf[1] === 0 && buf[0] !== 0) return buf.toString("utf16le").replace(/^﻿/, "");
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8").replace(/^﻿/, "");
}
