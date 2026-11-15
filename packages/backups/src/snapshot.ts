import { copyFile, lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const within = (root: string, path: string) => { const r = relative(root, path); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
async function isSqlite(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try { const header = Buffer.alloc(16); const { bytesRead } = await file.read(header, 0, 16, 0); return bytesRead === 16 && header.toString() === "SQLite format 3\0"; }
  finally { await file.close(); }
}

/** Snapshot app-owned files. WAL databases use SQLite's online backup API, never raw file copying. */
export async function snapshotDirectory(source: string, destination: string): Promise<void> {
  const root = await realpath(source);
  if (within(root, resolve(destination))) throw new Error("The backup staging folder must be outside the application folder.");
  const visiting = new Set<string>();
  const walk = async (from: string, to: string): Promise<void> => {
    const actual = await realpath(from);
    if (!within(root, actual)) throw new Error(`A linked file points outside the app folder: ${from}. Include its data explicitly before backing up.`);
    const info = await stat(actual);
    if (info.isDirectory()) {
      if (visiting.has(actual)) throw new Error(`Circular linked folder: ${from}`);
      visiting.add(actual);
      await mkdir(to, { recursive: true });
      try {
        for (const entry of await readdir(actual, { withFileTypes: true })) {
          const path = join(actual, entry.name);
          // Sidecars belong to the transaction snapshot, not the restored database.
          const base = path.replace(/-(wal|shm|journal)$/, "");
          if (base !== path) {
            try { if (await isSqlite(base)) continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          }
          await walk(path, join(to, entry.name));
        }
      } finally { visiting.delete(actual); }
    } else if (info.isFile()) {
      if (await isSqlite(actual)) {
        const db = new DatabaseSync(actual, { readOnly: true, timeout: 5000 });
        try { await backup(db, to); } finally { db.close(); }
        const check = new DatabaseSync(to, { readOnly: true });
        try { if (check.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error(`SQLite backup verification failed: ${from}`); }
        finally { check.close(); }
      } else {
        await copyFile(actual, to);
        const after = await stat(actual);
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error(`A file changed during backup: ${from}. Retry when its write has completed.`);
      }
    } else if ((await lstat(from)).isSymbolicLink()) {
      throw new Error(`Unsupported linked file: ${from}`);
    } else throw new Error(`Unsupported application file: ${from}`);
  };
  await walk(root, destination);
}
