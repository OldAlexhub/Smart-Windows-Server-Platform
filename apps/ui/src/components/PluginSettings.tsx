import { AlertTriangle, PackagePlus, PlugZap, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatBytes } from "@nexus/shared/format";
import { ApiError, del, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Card, ConfirmByName, Empty, ErrorNote, Modal, Spinner, Status } from "./ui";

interface Capability {
  id: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
}

interface Plugin {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  license: string;
  homepage: string | null;
  capabilities: Capability[];
  enabled: boolean;
  status: "installed" | "starting" | "running" | "stopped" | "crashed" | "tampered";
  lastError: string | null;
  installedAt: string;
  updatedAt: string;
  lastStartedAt: string | null;
  logs: { at: string; level: "info" | "warning" | "error"; message: string }[];
}

interface PluginState {
  capabilities: Capability[];
  plugins: Plugin[];
}

interface Inspection {
  manifest: {
    id: string;
    name: string;
    version: string;
    publisher: string;
    description: string;
    license: string;
    homepage?: string;
    capabilities: string[];
  };
  capabilities: Capability[];
  digest: string;
  files: number;
  bytes: number;
  sourceLabel: string;
}

function tone(plugin: Plugin): "good" | "warning" | "critical" | "neutral" {
  if (plugin.status === "running") return "good";
  if (plugin.status === "crashed" || plugin.status === "tampered") return "critical";
  if (plugin.status === "starting") return "warning";
  return "neutral";
}

function statusLabel(plugin: Plugin): string {
  if (plugin.status === "tampered") return "Files changed";
  if (plugin.status === "crashed") return "Needs attention";
  return plugin.status[0]!.toUpperCase() + plugin.status.slice(1);
}

function PackageModal({ current, onClose, onSaved }: { current?: Plugin; onClose: () => void; onSaved: () => void }) {
  const [sourceDir, setSourceDir] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [approved, setApproved] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function inspect() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<Inspection>("/plugins/inspect", { sourceDir: sourceDir.trim() });
      setInspection(result);
      setApproved([]);
      setConfirmation("");
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!inspection) return;
    setBusy(true);
    setError(null);
    try {
      const body = { sourceDir: sourceDir.trim(), approvedCapabilities: approved, confirmation };
      if (current) await post(`/plugins/${current.id}/update`, body);
      else await post("/plugins", body);
      onSaved();
      onClose();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const expectedName = current?.name ?? inspection?.manifest.name ?? "";
  const allApproved = !!inspection && inspection.capabilities.every((capability) => approved.includes(capability.id));
  return (
    <Modal
      title={current ? `Update ${current.name}` : "Install a plugin"}
      wide
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {!inspection ? (
            <button className="btn primary" disabled={busy || !sourceDir.trim()} onClick={() => void inspect()}>
              {busy ? <Spinner label="Inspecting…" /> : "Review Plugin"}
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={busy || !allApproved || confirmation !== expectedName}
              onClick={() => void save()}
            >
              {busy ? (
                <Spinner label={current ? "Updating…" : "Installing…"} />
              ) : current ? (
                "Update Plugin"
              ) : (
                "Install Plugin"
              )}
            </button>
          )}
        </>
      }
    >
      <div className="plugin-warning">
        <AlertTriangle size={21} />
        <span>
          <strong>Install only plugins you trust.</strong>
          <small>
            A local plugin runs code on this server. Nexus never runs install scripts or downloads dependencies, and the
            plugin starts switched off.
          </small>
        </span>
      </div>
      {!inspection ? (
        <div className="settings-form">
          <label className="field">
            Plugin folder
            <span className="hint">
              The folder containing nexus-plugin.json. The package must already be self-contained.
            </span>
            <input
              className="input mono"
              value={sourceDir}
              onChange={(e) => setSourceDir(e.target.value)}
              placeholder="C:\Plugins\my-plugin"
              autoFocus
            />
          </label>
        </div>
      ) : (
        <div className="plugin-review">
          <div className="plugin-review-head">
            <span className="settings-icon">
              <PlugZap size={21} />
            </span>
            <span>
              <strong>
                {inspection.manifest.name} <em>v{inspection.manifest.version}</em>
              </strong>
              <small>
                {inspection.manifest.publisher} · {inspection.manifest.license} · {inspection.files.toLocaleString()}{" "}
                files · {formatBytes(inspection.bytes)}
              </small>
            </span>
          </div>
          <p>{inspection.manifest.description}</p>
          {current && current.id !== inspection.manifest.id && (
            <div className="notice" style={{ color: "var(--critical-text)" }}>
              This package is {inspection.manifest.id}, not {current.id}.
            </div>
          )}
          <div>
            <h3>Approve capabilities</h3>
            <p className="small muted">
              Every requested capability must be approved. A future update must be approved again if this list changes.
            </p>
            <div className="plugin-capabilities">
              {inspection.capabilities.map((capability) => (
                <label className={`plugin-capability risk-${capability.risk}`} key={capability.id}>
                  <input
                    type="checkbox"
                    checked={approved.includes(capability.id)}
                    onChange={(e) =>
                      setApproved((all) =>
                        e.target.checked ? [...all, capability.id] : all.filter((id) => id !== capability.id),
                      )
                    }
                  />
                  <span>
                    <strong>
                      {capability.label}
                      <em>{capability.risk} impact</em>
                    </strong>
                    <small>{capability.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            Type <strong>{expectedName}</strong> to confirm
            <input
              className="input"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            className="btn ghost small"
            onClick={() => {
              setInspection(null);
              setApproved([]);
              setConfirmation("");
            }}
          >
            Choose another folder
          </button>
        </div>
      )}
      <ErrorNote error={error} />
    </Modal>
  );
}

export function PluginSettings() {
  const { data, error, loading, reload } = useApi<PluginState>("/plugins", 10_000);
  const [installing, setInstalling] = useState(false);
  const [updating, setUpdating] = useState<Plugin | null>(null);
  const [removing, setRemoving] = useState<Plugin | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  async function enable(plugin: Plugin, enabled: boolean) {
    setBusy(plugin.id);
    setActionError(null);
    try {
      await put(`/plugins/${plugin.id}/enabled`, { enabled });
      await reload();
    } catch (e) {
      setActionError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function restart(plugin: Plugin) {
    setBusy(plugin.id);
    setActionError(null);
    try {
      await post(`/plugins/${plugin.id}/restart`);
      await reload();
    } catch (e) {
      setActionError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await del(`/plugins/${removing.id}`, { confirmation: removing.name });
      setRemoving(null);
      await reload();
    } catch (e) {
      setActionError(e as ApiError);
      setRemoving(null);
    }
  }

  return (
    <>
      <Card
        title="Local plugins"
        sub="Add optional integrations without changing the Nexus service."
        action={
          <button className="btn primary small" onClick={() => setInstalling(true)}>
            <PackagePlus size={15} /> Install from Folder
          </button>
        }
      >
        {loading && !data ? (
          <Spinner label="Loading plugins…" />
        ) : error ? (
          <ErrorNote error={error} />
        ) : !data?.plugins.length ? (
          <Empty
            icon={<PlugZap size={32} />}
            title="No plugins installed"
            action={
              <button className="btn primary" onClick={() => setInstalling(true)}>
                Install a Plugin
              </button>
            }
          >
            Plugins are copied into Nexus, checked for changes before every start, and remain off until you approve and
            enable them.
          </Empty>
        ) : (
          <div className="plugin-list">
            {data.plugins.map((plugin) => (
              <article className="plugin-card" key={plugin.id}>
                <header>
                  <span className="settings-icon">
                    <PlugZap size={19} />
                  </span>
                  <span className="plugin-card-main">
                    <strong>
                      {plugin.name}
                      <em>v{plugin.version}</em>
                    </strong>
                    <small>
                      {plugin.publisher} · {plugin.license}
                    </small>
                  </span>
                  <Status tone={tone(plugin)} spinning={plugin.status === "starting"}>
                    {statusLabel(plugin)}
                  </Status>
                  <label className="toggle-mini">
                    <input
                      type="checkbox"
                      checked={plugin.enabled}
                      disabled={busy === plugin.id}
                      onChange={(e) => void enable(plugin, e.target.checked)}
                    />
                    <span>{plugin.enabled ? "On" : "Off"}</span>
                  </label>
                </header>
                <p>{plugin.description}</p>
                <div className="plugin-capability-pills">
                  {plugin.capabilities.map((capability) => (
                    <span key={capability.id} title={capability.description}>
                      {capability.label}
                    </span>
                  ))}
                </div>
                {plugin.lastError && <div className="notice plugin-error">{plugin.lastError}</div>}
                <footer>
                  <span className="small muted mono">{plugin.id}</span>
                  <span className="spacer" />
                  {plugin.enabled && (
                    <button className="btn small" disabled={busy === plugin.id} onClick={() => void restart(plugin)}>
                      <RotateCw size={13} /> Restart
                    </button>
                  )}
                  <button className="btn small" disabled={busy === plugin.id} onClick={() => setUpdating(plugin)}>
                    <RefreshCw size={13} /> Update
                  </button>
                  <button
                    className="btn ghost small danger"
                    disabled={busy === plugin.id}
                    onClick={() => setRemoving(plugin)}
                  >
                    <Trash2 size={14} /> Remove
                  </button>
                </footer>
                {plugin.logs.length > 0 && (
                  <details className="plugin-logs">
                    <summary>Recent plugin log</summary>
                    {plugin.logs.slice(-20).map((log, index) => (
                      <div className={log.level} key={`${log.at}-${index}`}>
                        <time>{new Date(log.at).toLocaleTimeString()}</time>
                        <span>{log.message}</span>
                      </div>
                    ))}
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
      </Card>
      <Card title="How plugins are contained">
        <div className="safety-list">
          <span>✓ No npm install, setup script, or automatic internet download is run</span>
          <span>✓ Installed files are SHA-256 checked before every start</span>
          <span>✓ Capabilities are declared, shown in plain language, and approved explicitly</span>
          <span>✓ Plugins receive no Nexus secrets automatically; integrations use a versioned JSON protocol</span>
        </div>
      </Card>
      <ErrorNote error={actionError} />
      {installing && <PackageModal onClose={() => setInstalling(false)} onSaved={() => void reload()} />}
      {updating && <PackageModal current={updating} onClose={() => setUpdating(null)} onSaved={() => void reload()} />}
      {removing && (
        <ConfirmByName
          name={removing.name}
          action="Remove Plugin"
          onClose={() => setRemoving(null)}
          onConfirm={() => void remove()}
        >
          <p>
            This stops <strong>{removing.name}</strong> and permanently removes its managed package and private runtime
            files. Other Nexus data is not removed.
          </p>
        </ConfirmByName>
      )}
    </>
  );
}
