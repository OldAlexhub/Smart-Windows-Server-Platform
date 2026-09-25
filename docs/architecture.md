# Nexus Server — Architecture

> Working name: **Nexus Server**. Branding lives in `packages/shared/src/brand.ts`; nothing else hard-codes the name.

## 1. Product principle

"Give Nexus your application and tell it what you want. Nexus handles the server."

Every feature passes two gates before it is built:

1. *Could this be automated?* → automate it.
2. *Does the user need to understand this concept?* → if not, hide it behind **Settings › Advanced**.

## 2. System overview

```
Windows 11 (host)
│
├── Nexus Desktop (Tauri shell, WebView2)  ──┐  management UI only; closing it stops nothing
│                                             │  HTTP (127.0.0.1 only, local-trust token)
├── Nexus Core Service (Windows Service) ◄────┘
│     ├── Application Manager   ├── Database Manager   ├── Storage Manager
│     ├── Deployment Manager    ├── Backup Manager     ├── AI Manager
│     ├── Network / Domain Mgr  ├── Monitoring Manager ├── Hardware Manager
│     ├── Security / Secrets    ├── User / Audit Mgr   ├── Pipeline Engine
│     └── Plugin Manager
│
├── PostgreSQL            (child of the service, 127.0.0.1:<private port>, never public)
├── HTTPS Gateway         (Caddy; the ONLY listener on 80/443)
├── AI Runtime            (Ollama / llama.cpp; 127.0.0.1 only)
├── Script runtimes       (managed Python venvs, isolated R libraries)
└── Applications          (isolated processes today; Podman on WSL2 when available)
```

Traffic from the internet always flows:

```
Internet → HTTPS (443) → Gateway (TLS, auth, rate limit) → app on 127.0.0.1:<port> → PostgreSQL on 127.0.0.1
```

Databases, the AI runtime, internal ports and the management API bind to loopback only. Remote administration
is off by default and, when enabled, is published through the same gateway with mandatory strong auth + MFA.

## 3. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Core service language | **TypeScript on Node.js 24 LTS** | One typed language across service, UI and contracts; first-class ecosystem for inspecting Node/Python projects; `node:sqlite`, `fetch`, `crypto` built in → few native deps; ships as a single bundled JS file + `node.exe`. |
| HTTP framework | **Fastify** | Fast, schema-first, mature, plugin model maps onto our module boundaries. |
| Validation / contracts | **zod** | Runtime-validated, typed API contracts shared with the UI. |
| Nexus's own state | **SQLite (`node:sqlite`)** | Embedded, zero-admin, transactional; versioned migrations in code. Business data never lives here. |
| Business database | **PostgreSQL** (bundled binaries) | Best open-source general-purpose RDBMS, excellent Windows builds, per-app DB+role isolation, `pg_dump` backups. Behind a `DatabaseEngine` interface so MySQL/Mongo/etc. are plugins. |
| HTTPS gateway | **Caddy** | Automatic ACME certificates + renewal, JSON config API, forward-auth, single static binary, Apache-2.0. Behind a `GatewayProvider` interface. |
| Secure remote reach | `NetworkProvider` adapters: **direct** (port-forward), **Cloudflare Tunnel**, **Tailscale** | No single vendor is required; offices without port-forwarding still work. |
| Isolation | `IsolationProvider`: **process isolation** (default) → **Podman on WSL2** (when available) | Windows 11 Home has no Hyper-V containers and WSL2 may be absent; process isolation (own release dir, scrubbed env, loopback bind, per-app DB role, resource watchdog) works everywhere, containers are used when present. |
| Secrets | **Windows DPAPI** (machine scope) wraps a master key; secrets encrypted with **AES-256-GCM** | No plaintext on disk; OS-bound key; exportable recovery key for backups. |
| Passwords | **scrypt** (Node crypto) | Memory-hard, no native dependency. |
| MFA | **TOTP (RFC 6238)** | Works with every authenticator app, offline. |
| Backups | `pg_dump` custom format + tar of config/files, **AES-256-GCM** encrypted | Portable, restorable with standard tools; `BackupTarget` adapters for remote providers later (restic-compatible design). |
| AI runtime | **Ollama** (default) / **llama.cpp** (adapter) | Open source, CUDA/ROCm/CPU auto-selection, local-only, offline. Model chosen from detected RAM/VRAM. |
| UI | **React + Vite** | Mature, huge ecosystem, served by the service so the same UI works locally and remotely. |
| Desktop shell | **Tauri 2** | Native WebView2, ~10 MB footprint, Rust, NSIS bundler produces `NexusSetup.exe`, Start-menu/desktop shortcuts, tray. |
| Windows service | **WinSW** wrapper around `node.exe` | Proven, MIT licensed, restart-on-failure, log rotation. |
| Pipelines | Built-in DAG engine; Python (venv) and R (isolated library/renv) steps; Parquet/CSV/Arrow hand-off | No external orchestrator to install; Python and R are equal first-class citizens. |
| Tests | **vitest** | Fast, TS-native. |

## 4. Repository layout

```
apps/
  server/     Nexus Core Service (composition root, HTTP API, service host)
  ui/         React control center (served by the service)
  desktop/    Tauri shell → NexusSetup.exe
packages/
  shared/     brand, contracts, errors, logger, friendly-error model
  state/      SQLite state store + migration framework
  security/   secrets, users, sessions, RBAC, MFA, rate limit, audit
  hardware/   detection + recommended configuration
  detection/  application analysis (Node, Python, static, env, DB, ports)
  runtime/    isolation providers, process supervisor, logs, health
  deployment/ releases, dependency install, history, rollback
  database/   PostgreSQL engine, provisioning, app connection wiring, data browser
  network/    ports, gateway (Caddy), network providers, firewall, domains
  storage/    per-app file storage
  backups/    backup + restore
  ai/         hardware planner, runtimes, permission engine, assistant
  monitoring/ system + process metrics
  pipelines/  ETL/ELT engine, connectors, Python/R steps, scheduler
  plugins/    plugin manifest + lifecycle
sdk/
  python/nexus   helper library for pipeline scripts
  r/nexusR       helper library for pipeline scripts
scripts/      build, component fetch, service install
docs/         architecture and design notes
tests/        end-to-end scenarios
```

Every infrastructure dependency sits behind an interface in its package (`DatabaseEngine`, `GatewayProvider`,
`NetworkProvider`, `IsolationProvider`, `AiRuntime`, `BackupTarget`, `Connector`). Components can be upgraded or
replaced individually; plugins register additional implementations.

## 5. Security model (summary)

- Management API: loopback only by default. Local desktop authenticates with a machine-local trust token
  (ACL'd file). Remote admin is opt-in and requires password + TOTP.
- RBAC: Owner, Administrator, Developer, Operator, Viewer, Application User; per-application role overrides.
- Apps get scoped API tokens that can only reach their own storage bucket, secrets and logs.
- Each app gets its own PostgreSQL database and role with least privilege; the superuser password never leaves the vault.
- Brute-force lockout, rate limiting, suspicious-login detection, append-only audit log.
- AI runs under a permission engine: **Observe → Recommend (default) → Execute after approval**; a hard deny list
  (delete backups, drop production DBs, disable security) cannot be approved.

## 6. Offline-first

Everything except public HTTPS issuance, DNS, remote access and downloads works with the internet down:
apps, PostgreSQL, storage, backups, pipelines and local AI all run on-box.

## 7. Delivery phases

See `checklist.md` at the repository root — it is the single source of truth for progress.
