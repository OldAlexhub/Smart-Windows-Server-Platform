# Nexus local plugin format

Nexus plugins are self-contained local folders. Nexus does not run `npm install`, setup scripts, or
automatic downloads. An administrator reviews the manifest and approves every capability, then
Nexus copies the folder into its managed data directory. A new plugin is always installed **off**.

Only install code you trust. A plugin is a local process running under the Nexus service identity;
capabilities control which Nexus protocol operations the host will send, but they are not an
operating-system sandbox.

## Package layout

```text
weather-plugin/
  nexus-plugin.json
  dist/main.mjs
```

`nexus-plugin.json`:

```json
{
  "nexus": "plugin/v1",
  "id": "acme.weather",
  "name": "Acme Weather",
  "version": "1.2.0",
  "apiVersion": 1,
  "publisher": "Acme",
  "description": "Adds weather data blocks.",
  "license": "Apache-2.0",
  "homepage": "https://example.com/weather-plugin",
  "entry": "dist/main.mjs",
  "capabilities": ["pipelines.steps"]
}
```

IDs use lowercase letters, numbers, dots, and dashes. Versions use semantic versioning. The entry
must be a `.js` or `.mjs` file inside the package. Symbolic links and junctions are refused.

## Capabilities

| Capability | Contribution |
|---|---|
| `pipelines.steps` | Pipeline sources, transformations, or destinations |
| `applications.detect` | Framework and language detection |
| `database.engines` | Database engine providers |
| `network.providers` | Application publishing/network providers |
| `backup.targets` | Destinations for encrypted backup archives |
| `ai.runtimes` | Local AI runtime/model providers |
| `server.events` | Non-secret lifecycle and health events |

Every capability must be approved on install and update. Nexus never passes secrets merely because
a plugin declares a capability.

## Process protocol

The entry runs with a private home/temp folder and a scrubbed environment. It communicates as
newline-delimited JSON over standard input/output. Its first output must be:

```json
{"type":"ready","protocol":1,"capabilities":["pipelines.steps"]}
```

The capability list must exactly match the manifest. Nexus sends requests only after this handshake:

```json
{"type":"request","id":"...","capability":"pipelines.steps","action":"pipeline.catalog","payload":{}}
```

The plugin answers with either:

```json
{"type":"response","id":"...","ok":true,"result":{}}
{"type":"response","id":"...","ok":false,"error":"Plain-language explanation"}
```

Optional log records use `{"type":"log","level":"info|warning|error","message":"..."}`. Messages
and requests are limited to 1 MB. Requests have a timeout, and process trees are stopped when the
plugin is disabled, updated, removed, or Nexus shuts down.

## Lifecycle and integrity

- Install copies a validated package and records a SHA-256 digest; it does not execute code.
- Enable verifies the digest, starts the process, and requires the protocol handshake.
- Restart stops the complete process tree before starting it again.
- Update stages a private copy and preserves the previous version. If an enabled update cannot
  become ready, Nexus restores and restarts the previous version.
- Remove requires typing the plugin name, stops it, and deletes its managed package/runtime files.
- Enabled plugins start again with Nexus. Unexpected exits are shown as **Needs attention**.
