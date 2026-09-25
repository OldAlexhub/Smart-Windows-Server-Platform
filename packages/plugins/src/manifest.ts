import { isAbsolute, normalize, sep } from "node:path";
import { z } from "zod";
import { NexusError } from "@nexus/shared";

export const PLUGIN_API_VERSION = 1 as const;

export const PLUGIN_CAPABILITIES = {
  "pipelines.steps": {
    label: "Pipeline blocks",
    description: "Adds data source, transformation, or destination blocks to pipelines.",
    risk: "medium",
  },
  "applications.detect": {
    label: "Application detection",
    description: "Inspects an application folder to recognise additional frameworks or languages.",
    risk: "medium",
  },
  "database.engines": {
    label: "Database engines",
    description: "Adds a database engine and may start or stop its local server processes.",
    risk: "high",
  },
  "network.providers": {
    label: "Network providers",
    description: "Adds a way to publish applications or change network configuration.",
    risk: "high",
  },
  "backup.targets": {
    label: "Backup destinations",
    description: "Receives encrypted backup archives and may connect to another computer or service.",
    risk: "high",
  },
  "ai.runtimes": {
    label: "AI runtimes",
    description: "Adds a local AI runtime or model provider.",
    risk: "medium",
  },
  "server.events": {
    label: "Server events",
    description: "Receives non-secret lifecycle and health events from Nexus.",
    risk: "low",
  },
} as const;

export type PluginCapability = keyof typeof PLUGIN_CAPABILITIES;
export type CapabilityInfo = (typeof PLUGIN_CAPABILITIES)[PluginCapability] & { id: PluginCapability };

const capability = z.enum(Object.keys(PLUGIN_CAPABILITIES) as [PluginCapability, ...PluginCapability[]]);
const relativeEntry = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => {
    if (isAbsolute(value) || value.includes("\0")) return false;
    const n = normalize(value);
    return n !== ".." && !n.startsWith(`..${sep}`);
  }, "The entry file must stay inside the plugin folder.")
  .refine((value) => /\.(?:mjs|js)$/i.test(value), "Plugins use a self-contained .js or .mjs entry file.");

export const pluginManifestSchema = z
  .object({
    nexus: z.literal("plugin/v1"),
    id: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, "Use lowercase letters, numbers, dots, and dashes."),
    name: z.string().trim().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Use a semantic version such as 1.2.0."),
    apiVersion: z.literal(PLUGIN_API_VERSION),
    publisher: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    license: z.string().trim().min(1).max(100),
    homepage: z.url().max(500).optional(),
    entry: relativeEntry,
    capabilities: z.array(capability).min(1).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.capabilities.forEach((item, index) => {
      if (seen.has(item))
        ctx.addIssue({ code: "custom", path: ["capabilities", index], message: `${item} is listed more than once.` });
      seen.add(item);
    });
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export function parsePluginManifest(value: unknown): PluginManifest {
  const parsed = pluginManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const where = first?.path.length ? `${first.path.join(".")}: ` : "";
  throw NexusError.invalid(
    `This isn't a valid Nexus plugin manifest. ${where}${first?.message ?? "Check nexus-plugin.json."}`,
  );
}

export function capabilityInfo(ids: readonly PluginCapability[]): CapabilityInfo[] {
  return ids.map((id) => ({ id, ...PLUGIN_CAPABILITIES[id] }));
}
