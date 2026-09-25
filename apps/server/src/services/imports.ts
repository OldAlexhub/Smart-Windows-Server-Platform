import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  analyzeImport,
  importFormat,
  runImport,
  type ImportAnalysis,
  type ImportFileOptions,
  type ImportPlan,
} from "@nexus/pipelines";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { PipelineService } from "./pipelines";

const KEEP_UPLOADS_MS = 24 * 60 * 60 * 1000;
const UPLOAD_ID = /^[0-9a-f-]{36}$/;

interface UploadMeta {
  databaseId: string;
  fileName: string;
  file: string;
  uploadedAt: string;
}

export interface ImportPreview extends ImportAnalysis {
  importId: string;
  fileName: string;
  /** Tables already in the database, for "add the rows to an existing table". */
  existingTables: string[];
}

/**
 * The data import wizard (CSV, Excel, JSON → a PostgreSQL table). Uploads wait in a private folder
 * until they are imported, cancelled, or a day old.
 */
export class DataImportService {
  private readonly running = new Set<string>();

  constructor(
    private readonly ctx: NexusContext,
    private readonly pipelines: PipelineService,
  ) {}

  private get root(): string {
    return join(this.pipelines.workRoot, "imports");
  }

  private options(meta: UploadMeta, dir: string, sheet?: string | null): ImportFileOptions {
    return {
      file: meta.file,
      format: importFormat(meta.fileName),
      sheet: sheet ?? null,
      workDir: dir,
      extensions: {
        excel: this.pipelines.extensionFile("excel"),
        postgres: this.pipelines.extensionFile("postgres_scanner"),
      },
    };
  }

  private upload(databaseId: string, importId: string): { meta: UploadMeta; dir: string } {
    const dir = join(this.root, importId);
    if (!UPLOAD_ID.test(importId) || !existsSync(join(dir, "upload.json"))) throw NexusError.notFound("Upload");
    const meta = JSON.parse(readFileSync(join(dir, "upload.json"), "utf8")) as UploadMeta;
    if (meta.databaseId !== databaseId) throw NexusError.notFound("Upload");
    return { meta, dir };
  }

  private async tables(databaseId: string): Promise<string[]> {
    return this.ctx.dataBrowser ? (await this.ctx.dataBrowser.listTables(databaseId)).map((t) => t.name) : [];
  }

  /** Removes uploads nobody finished within a day. */
  private sweep(): void {
    if (!existsSync(this.root)) return;
    for (const name of readdirSync(this.root)) {
      const dir = join(this.root, name);
      try {
        if (Date.now() - statSync(dir).mtimeMs > KEEP_UPLOADS_MS) rmSync(dir, { recursive: true, force: true });
      } catch {
        // In use or already gone.
      }
    }
  }

  /** Saves an uploaded file and analyses it. */
  async receive(databaseId: string, fileName: string, stream: Readable): Promise<ImportPreview> {
    if (!this.ctx.databases) throw NexusError.conflict("The database server isn't available yet.");
    this.ctx.databases.require(databaseId);
    fileName = basename(fileName).slice(0, 255);
    importFormat(fileName); // refuse unsupported files before saving them
    this.sweep();
    const importId = randomUUID();
    const dir = join(this.root, importId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `source${extname(fileName).toLowerCase()}`);
    try {
      await pipeline(stream, createWriteStream(file));
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    if (statSync(file).size === 0) {
      rmSync(dir, { recursive: true, force: true });
      throw NexusError.invalid("This file is empty.");
    }
    const meta: UploadMeta = { databaseId, fileName, file, uploadedAt: new Date().toISOString() };
    writeFileSync(join(dir, "upload.json"), JSON.stringify(meta));
    try {
      return await this.analyze(databaseId, importId);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  async analyze(databaseId: string, importId: string, sheet?: string | null): Promise<ImportPreview> {
    const { meta, dir } = this.upload(databaseId, importId);
    const existingTables = await this.tables(databaseId);
    const analysis = await analyzeImport(this.options(meta, dir, sheet), meta.fileName, existingTables);
    return { importId, fileName: meta.fileName, existingTables, ...analysis };
  }

  async run(
    databaseId: string,
    importId: string,
    plan: ImportPlan,
    sheet?: string | null,
  ): Promise<{ rows: number; table: string; generatedKey: string | null }> {
    if (this.running.has(importId)) throw NexusError.conflict("This import is already running.");
    const { meta, dir } = this.upload(databaseId, importId);
    const table = plan.table.trim().toLowerCase();
    const browser = this.ctx.dataBrowser;
    const exists = (await this.tables(databaseId)).includes(table);
    const existingColumns =
      exists && browser ? (await browser.describe(databaseId, table)).columns.map((c) => c.name) : null;
    const url = await this.pipelines.databaseUrl(databaseId);
    this.running.add(importId);
    try {
      const result = await runImport(this.options(meta, dir, sheet), url, plan, existingColumns);
      rmSync(dir, { recursive: true, force: true });
      const db = this.ctx.databases?.get(databaseId);
      this.ctx.activity.add(
        "success",
        `${result.rows.toLocaleString("en-US")} rows from ${meta.fileName} were imported into ${result.table}${db ? ` (${db.name})` : ""}.`,
      );
      return result;
    } finally {
      this.running.delete(importId);
    }
  }

  cancel(databaseId: string, importId: string): void {
    if (this.running.has(importId)) throw NexusError.conflict("This import is running and can't be cancelled now.");
    const { dir } = this.upload(databaseId, importId);
    rmSync(dir, { recursive: true, force: true });
  }
}
