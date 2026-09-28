# Nexus Server

**Turn a Windows PC into your own private server for apps, databases, files, data pipelines and local AI, without learning server administration.**

Pick an app folder, press **Deploy**, and Nexus handles the rest. It detects what the app needs, installs its dependencies, creates and connects its database, keeps its files, publishes it over HTTPS, watches its health, and backs it all up. Everything runs on your own machine. Nexus needs no cloud account and makes no calls home; its bundled components are pinned, checksum-verified, and use open-source or source-available licences.

> Status: working, under active development (v0.1). Windows 10/11, 64-bit.

---

## What it does

| | |
|---|---|
| **One-click app hosting** | Node.js, Python (Flask, FastAPI, Django…), R Shiny (`app.R`), static sites and more are detected automatically and run as supervised, isolated processes. Releases are immutable, so rollback is one click. |
| **Managed databases** | PostgreSQL for tables, plus isolated MongoDB replica sets for document applications, including real multi-document transactions and exact BSON types. Existing FerretDB-on-PostgreSQL databases remain supported as a legacy compatibility engine. Each app gets its own database and login, wired into the setting names its code already uses (`DATABASE_URL`, `MONGO_URL`, …). |
| **Data tools** | Spreadsheet-style browser, CSV/Excel/JSON import that suggests the table and key, and read-only "ask a question" queries with charts. |
| **Pipelines** | Visual designer and YAML pipelines (SQL, Python, R, connectors) on a sandboxed DuckDB engine, with schedules, retries, resume-from-failure, versioning and plain-English failure explanations. |
| **Backups** | Encrypted (AES-256-GCM) and verified, on a schedule, with full or partial restore. They work on NTFS and exFAT drives. |
| **Secure access** | A Caddy gateway with automatic HTTPS for public apps, sign-in-protected or API-key-only apps, and a built-in **WireGuard private network** (phone QR codes, no account). Remote administration requires two-step verification. |
| **Local AI** | Uses Ollama with open-source models only (Qwen 3, gpt-oss) sized to your GPU. It explains errors, answers questions about the server, and drafts pipelines. It can only recommend; it never changes anything on its own. |
| **Self-healing** | It repairs port conflicts, stale processes and broken configuration, and restarts crashed apps while watching for crash loops. |
| **Friendly by design** | Every error comes with a plain-language explanation and a next step. The advanced detail sits behind *Settings › Advanced*. |

---

## Install (users)

1. Download **`NexusSetup.exe`** (or build it, see below) and run it. Your data is kept on upgrades.
2. Open **Nexus** from the Start menu. You're signed in automatically on that computer.
3. Follow the first-run screen. It recommends where to keep apps, databases and backups.

Prefer not to install? **`NexusPortable.zip`** runs from any folder or USB drive: unzip it, then run `Start Nexus.cmd`.

**Optional extras** (free, installed separately):
- **[Ollama](https://ollama.com)** turns on Nexus AI.
- **[WireGuard for Windows](https://www.wireguard.com/install/)** turns on the private network.

Guides:
- **[HOW-TO-USE-NEXUS.md](HOW-TO-USE-NEXUS.md)**: every feature, step by step, in plain language.
- **[PRACTICAL-GUIDE.md](PRACTICAL-GUIDE.md)**: task-based recipes (deploy an app, publish a domain, backups, pipelines, …).

---

## Develop

### Requirements
- Windows 10/11 x64
- **Node.js ≥ 22.13** (the bundled runtime is Node 24)
- **Git**
- To build the installer: **Rust** (stable, MSVC toolchain), for the Tauri desktop shell

### First run

```powershell
npm install

# Download the pinned third-party components into vendor/ (sha256-verified):
# PostgreSQL, MongoDB, Caddy, Python, WinSW, DuckDB extensions, and FerretDB (built from source with a pinned Go).
node scripts/fetch-components.mjs

# Start the Core Service from source (state in .nexus-dev/). It prints a one-click sign-in link.
npm run dev:server

# In a second terminal: the control-center UI with hot reload at http://localhost:5173
npm run dev:ui
```

### Everyday commands

| Command | What it does |
|---|---|
| `npm test` | Runs the full test suite (Vitest, ~550 tests; many start a real PostgreSQL and Caddy). |
| `npm run typecheck` | Type-checks all TypeScript. |
| `npm run format` | Formats the code with Prettier. |
| `node scripts/build.mjs` | Builds the full installation into `dist/app`, then `dist/NexusSetup.exe` and `dist/NexusPortable.zip`. |
| `node scripts/build.mjs --no-installer` | Stages `dist/app` and the portable copy only (no Rust needed). |
| `node scripts/ui-drive.mjs …` | Drives the UI in headless Edge for end-to-end walkthroughs. |

---

## How it's built

```
Nexus Desktop (Tauri, WebView2) ──HTTP 127.0.0.1──▶ Nexus Core Service (Windows service, Node.js)
                                                     ├── Applications, deployments, runtime supervision
                                                     ├── PostgreSQL + MongoDB   (127.0.0.1 only)
                                                     │   └── FerretDB legacy compatibility
                                                     ├── Caddy HTTPS gateway     (the only public listener)
                                                     ├── Pipelines (DuckDB, Python, R)
                                                     ├── Backups, monitoring, logs, audit, plugins
                                                     └── Ollama AI runtime       (127.0.0.1 only)
```

A TypeScript monorepo (npm workspaces):

| Path | Contents |
|---|---|
| `apps/server` | The Core Service: HTTP API (Fastify), services, Windows-service entry point |
| `apps/ui` | The control center (React + Vite) |
| `apps/desktop` | The Tauri desktop shell and NSIS installer hooks |
| `packages/detection` | Works out what an app is and what it needs from its folder |
| `packages/deployment` | Immutable releases, dependency installs, the bundled Python |
| `packages/runtime` | Process supervision, isolation, health checks |
| `packages/database` | PostgreSQL, MongoDB replica-set and legacy FerretDB management, data browser, app wiring |
| `packages/network` | Gateway (Caddy), domains, firewall, WireGuard, UPnP |
| `packages/pipelines` | The pipeline engine, connectors, scheduler, templates |
| `packages/backups` | Encrypted backup and restore |
| `packages/ai` | Model planning by hardware, the Ollama runtime, data questions |
| `packages/security` | Users, sessions, MFA, roles, the secret vault, audit |
| `packages/monitoring`, `hardware`, `logs`, `storage`, `state`, `plugins`, `shared` | Supporting modules |

More detail: [docs/architecture.md](docs/architecture.md) · plugin development: [docs/plugins.md](docs/plugins.md).

### Security at a glance
- Databases, the AI runtime and internal services listen on **127.0.0.1 only**. The gateway is the only thing that can face the internet.
- Each app gets its **own database login**. Secrets live in an encrypted vault and are handed to apps only at start.
- The Windows service locks its data folder to SYSTEM and Administrators. It **never runs programs from user-writable folders**, which is why it ships its own Python and only uses machine-wide installs.
- Remote administration is **off by default** and always needs a password plus two-step verification.

---

## Third-party components and licences

Bundled components are pinned by version and SHA-256 in [`components.json`](components.json). Most use OSI-approved open-source licences. MongoDB Community Server uses the source-available SSPL v1, so distributors and hosted-service operators should review its terms for their use case.

| Component | Licence |
|---|---|
| PostgreSQL | PostgreSQL License |
| MongoDB Community Server | Server Side Public License v1 (source-available) |
| FerretDB (built from source) | Apache-2.0 |
| Caddy | Apache-2.0 |
| CPython (python-build-standalone) | PSF-2.0 |
| DuckDB and extensions | MIT |
| WinSW | MIT |
| Node.js | MIT |
| AI models: Qwen 3, gpt-oss, Nomic Embed | Apache-2.0 |

Ollama and WireGuard are optional and installed by the user. They aren't bundled because their Windows packages include separately licensed binaries.

---

## Licence

No licence file has been added yet. Until one is, all rights are reserved by the author.
