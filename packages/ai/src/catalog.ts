/**
 * Open-source models Nexus can run locally (open weights under an open-source licence). This is data, not code: it ships with Nexus and
 * is refreshed through component updates as better open models appear. Sizes are for the
 * default 4-bit quantisation (Q4_K_M) in the Ollama library.
 */
export interface ModelEntry {
  /** Runtime tag, e.g. "qwen3:8b". */
  id: string;
  family: string;
  parametersB: number;
  /** Download / weight size in GB at the default quantisation. */
  sizeGb: number;
  /** KV-cache cost per 1K tokens of context, in GB (approximate). */
  kvGbPer1k: number;
  maxContext: number;
  purposes: ("chat" | "sql" | "code" | "embed")[];
  license: string;
}

/** Only models under open-source licences may be listed (checked by the tests). */
export const OPEN_SOURCE_LICENSES = ["Apache-2.0", "MIT", "BSD-3-Clause"];

export const MODEL_CATALOG: ModelEntry[] = [
  { id: "qwen3:1.7b", family: "Qwen 3", parametersB: 1.7, sizeGb: 1.4, kvGbPer1k: 0.028, maxContext: 32768, purposes: ["chat", "sql"], license: "Apache-2.0" },
  { id: "qwen3:4b", family: "Qwen 3", parametersB: 4, sizeGb: 2.6, kvGbPer1k: 0.036, maxContext: 32768, purposes: ["chat", "sql", "code"], license: "Apache-2.0" },
  { id: "qwen3:8b", family: "Qwen 3", parametersB: 8, sizeGb: 5.2, kvGbPer1k: 0.036, maxContext: 32768, purposes: ["chat", "sql", "code"], license: "Apache-2.0" },
  { id: "qwen3:14b", family: "Qwen 3", parametersB: 14, sizeGb: 9.3, kvGbPer1k: 0.08, maxContext: 32768, purposes: ["chat", "sql", "code"], license: "Apache-2.0" },
  { id: "gpt-oss:20b", family: "gpt-oss", parametersB: 21, sizeGb: 14, kvGbPer1k: 0.05, maxContext: 131072, purposes: ["chat", "sql", "code"], license: "Apache-2.0" },
  { id: "qwen3:32b", family: "Qwen 3", parametersB: 32, sizeGb: 20, kvGbPer1k: 0.13, maxContext: 32768, purposes: ["chat", "sql", "code"], license: "Apache-2.0" },
  { id: "gpt-oss:120b", family: "gpt-oss", parametersB: 117, sizeGb: 65, kvGbPer1k: 0.07, maxContext: 131072, purposes: ["chat", "sql", "code"], license: "Apache-2.0" },
];

export const EMBEDDING_MODEL: ModelEntry = {
  id: "nomic-embed-text",
  family: "Nomic Embed",
  parametersB: 0.14,
  sizeGb: 0.3,
  kvGbPer1k: 0,
  maxContext: 8192,
  purposes: ["embed"],
  license: "Apache-2.0",
};

export function findModel(id: string, catalog = MODEL_CATALOG): ModelEntry | undefined {
  return catalog.find((m) => m.id === id) ?? (id === EMBEDDING_MODEL.id ? EMBEDDING_MODEL : undefined);
}
