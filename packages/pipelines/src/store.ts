import { newId, NexusError, slugify } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";
import { canonical, normalizePipeline, pipelineHash, type NormalizedPipeline } from "./definition";
import { diffPipelineDefinitions, type PipelineChange } from "./versioning";

export const pipelineMigrations: Migration[] = [
  {
    id: "pipelines/001_pipelines",
    up: `CREATE TABLE pipelines (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      current_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE pipeline_versions (
      pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      hash TEXT NOT NULL,
      author TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (pipeline_id, version)
    );`,
  },
  {
    id: "pipelines/005_version_sources",
    up: "ALTER TABLE pipeline_versions ADD COLUMN source_version INTEGER",
  },
];

export interface PipelineRecord {
  id: string;
  /** Stable address for the API (/api/v1/pipelines/<slug>/run); kept when the pipeline is renamed. */
  slug: string;
  name: string;
  /** Scheduled and triggerable. New pipelines start switched off so they can be tested first. */
  enabled: boolean;
  version: number;
  definition: NormalizedPipeline;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineVersion {
  version: number;
  hash: string;
  author: string | null;
  note: string | null;
  createdAt: string;
  /** Set when this version restored an older definition. */
  restoredFrom: number | null;
  definition: NormalizedPipeline;
}

export interface PipelineVersionDiff {
  pipelineId: string;
  fromVersion: number;
  toVersion: number;
  changes: PipelineChange[];
}

interface Row {
  id: string;
  slug: string;
  name: string;
  enabled: number;
  current_version: number;
  created_at: string;
  updated_at: string;
}

/** Pipelines and every saved version of them. */
export class PipelineStore {
  constructor(private readonly store: StateStore) {
    store.migrate(pipelineMigrations);
  }

  list(): PipelineRecord[] {
    return this.store.all<Row>("SELECT * FROM pipelines ORDER BY name COLLATE NOCASE").map((r) => this.toRecord(r));
  }

  get(idOrSlug: string): PipelineRecord | undefined {
    const r = this.store.get<Row>("SELECT * FROM pipelines WHERE id = ? OR slug = ?", [idOrSlug, idOrSlug]);
    return r ? this.toRecord(r) : undefined;
  }

  require(idOrSlug: string): PipelineRecord {
    const p = this.get(idOrSlug);
    if (!p) throw NexusError.notFound("Pipeline");
    return p;
  }

  create(raw: unknown, author: string | null = null): PipelineRecord {
    const def = normalizePipeline(raw);
    const id = newId();
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run("INSERT INTO pipelines (id, slug, name, enabled, current_version, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)", [
        id,
        this.uniqueSlug(def.name),
        def.name,
        now,
        now,
      ]);
      this.insertVersion(id, 1, def, author, "Created");
    });
    return this.require(id);
  }

  /**
   * Saves a new definition. Returns `changed: false` when nothing meaningful changed; moving blocks
   * around in the designer updates the layout without creating a new version.
   */
  update(id: string, raw: unknown, author: string | null = null, note: string | null = null): { pipeline: PipelineRecord; changed: boolean } {
    const current = this.require(id);
    const def = normalizePipeline(raw);
    const hash = pipelineHash(def);
    if (hash === pipelineHash(current.definition)) {
      if (canonical(def) !== canonical(current.definition)) {
        this.store.run("UPDATE pipeline_versions SET definition = ? WHERE pipeline_id = ? AND version = ?", [JSON.stringify(def), current.id, current.version]);
      }
      return { pipeline: this.require(id), changed: false };
    }
    const version = current.version + 1;
    this.store.transaction(() => {
      this.insertVersion(current.id, version, def, author, note);
      this.store.run("UPDATE pipelines SET name = ?, current_version = ?, updated_at = ? WHERE id = ?", [def.name, version, new Date().toISOString(), current.id]);
    });
    return { pipeline: this.require(id), changed: true };
  }

  setEnabled(id: string, enabled: boolean): PipelineRecord {
    const p = this.require(id);
    this.store.run("UPDATE pipelines SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, new Date().toISOString(), p.id]);
    return this.require(p.id);
  }

  remove(id: string): void {
    const p = this.require(id);
    this.store.run("DELETE FROM pipelines WHERE id = ?", [p.id]);
  }

  versions(id: string): PipelineVersion[] {
    const p = this.require(id);
    return this.store
      .all<VersionRow>("SELECT * FROM pipeline_versions WHERE pipeline_id = ? ORDER BY version DESC", [p.id])
      .map(toVersion);
  }

  version(id: string, version: number): PipelineVersion {
    const p = this.require(id);
    const r = this.store.get<VersionRow>("SELECT * FROM pipeline_versions WHERE pipeline_id = ? AND version = ?", [p.id, version]);
    if (!r) throw NexusError.notFound(`Version ${version}`);
    return toVersion(r);
  }

  diff(id: string, fromVersion: number, toVersion?: number): PipelineVersionDiff {
    const pipeline = this.require(id);
    const from = this.version(pipeline.id, fromVersion);
    const to = this.version(pipeline.id, toVersion ?? pipeline.version);
    return { pipelineId: pipeline.id, fromVersion: from.version, toVersion: to.version, changes: diffPipelineDefinitions(from.definition, to.definition) };
  }

  /** Restores an older definition as a new immutable version; existing history is never rewritten. */
  rollback(id: string, targetVersion: number, author: string | null = null, note?: string): PipelineRecord {
    const current = this.require(id);
    const target = this.version(current.id, targetVersion);
    if (pipelineHash(target.definition) === pipelineHash(current.definition)) throw NexusError.conflict(`This pipeline already matches version ${targetVersion}.`);
    const version = current.version + 1;
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.insertVersion(current.id, version, target.definition, author, note ?? `Rolled back to version ${targetVersion}`, targetVersion);
      this.store.run("UPDATE pipelines SET name = ?, current_version = ?, updated_at = ? WHERE id = ?", [target.definition.name, version, now, current.id]);
    });
    return this.require(current.id);
  }

  private insertVersion(id: string, version: number, def: NormalizedPipeline, author: string | null, note: string | null, sourceVersion: number | null = null): void {
    this.store.run("INSERT INTO pipeline_versions (pipeline_id, version, definition, hash, author, note, created_at, source_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      version,
      JSON.stringify(def),
      pipelineHash(def),
      author,
      note,
      new Date().toISOString(),
      sourceVersion,
    ]);
  }

  private uniqueSlug(name: string): string {
    const base = slugify(name, 40) || "pipeline";
    let slug = base;
    for (let i = 2; this.store.get("SELECT 1 FROM pipelines WHERE slug = ?", [slug]); i++) slug = `${base}-${i}`;
    return slug;
  }

  private toRecord(r: Row): PipelineRecord {
    const v = this.store.get<{ definition: string }>("SELECT definition FROM pipeline_versions WHERE pipeline_id = ? AND version = ?", [r.id, r.current_version])!;
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      enabled: !!r.enabled,
      version: r.current_version,
      definition: JSON.parse(v.definition) as NormalizedPipeline,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

interface VersionRow {
  version: number;
  definition: string;
  hash: string;
  author: string | null;
  note: string | null;
  created_at: string;
  source_version: number | null;
}

const toVersion = (r: VersionRow): PipelineVersion => ({
  version: r.version,
  hash: r.hash,
  author: r.author,
  note: r.note,
  createdAt: r.created_at,
  restoredFrom: r.source_version,
  definition: JSON.parse(r.definition) as NormalizedPipeline,
});
