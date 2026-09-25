import { Check, Download, ExternalLink, Laptop, Plus, ShieldCheck, Smartphone, Trash2, TriangleAlert } from "lucide-react";
import qrcode from "qrcode-generator";
import { useMemo, useState } from "react";
import { ApiError, del, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Card, ErrorNote, Modal, Spinner, Status } from "./ui";

interface PrivateNetworkState {
  wireguardInstalled: boolean;
  enabled: boolean;
  running: boolean;
  address: string | null;
  port: number;
  endpointHost: string | null;
  router: { status: "forwarded" | "manual" | "shared_address" | "unknown"; message: string };
  controlCenterUrl: string | null;
  apps: { appId: string; name: string; url: string }[];
  devices: { id: string; name: string; address: string; createdAt: string; lastSeen: string | null }[];
}

const ago = (iso: string | null) => {
  if (!iso) return "Never connected";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 180) return "Connected now";
  if (s < 3600) return `Last seen ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Last seen ${Math.floor(s / 3600)} h ago`;
  return `Last seen ${new Date(iso).toLocaleDateString()}`;
};

/** The QR code a phone's WireGuard app scans (drawn locally, the configuration never leaves this page). */
function QrCode({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }, [text]);
  return <div className="pn-qr" role="img" aria-label="QR code for the WireGuard app" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * Settings › External Access › Private network. WireGuard, run by Nexus: no account, no company in
 * the middle. Devices scan a QR code once and can then reach this computer from anywhere.
 */
export function PrivateNetwork({ canManage }: { canManage: boolean }) {
  const { data, error, reload } = useApi<PrivateNetworkState>("/network/private", 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [adding, setAdding] = useState<{ name: string; result: { device: { name: string }; config: string } | null } | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <Card title="Private network"><ErrorNote error={error} />{!error && <Spinner label="Checking…" />}</Card>;

  const setUp = (
    <button className="btn primary small" disabled={!canManage || busy !== null || !data.wireguardInstalled} onClick={() => void act("enable", () => post("/network/private/enable"))}>
      {busy === "enable" ? <Spinner label="Setting up…" /> : "Set up"}
    </button>
  );

  return (
    <Card
      title="Private network (WireGuard)"
      sub="Reach your apps and this control center from your own phone and laptop, anywhere. No account and no company in the middle."
      action={data.enabled ? <Status tone={data.running ? "good" : "warning"}>{data.running ? "On" : "Starting"}</Status> : setUp}
    >
      {!data.enabled && (
        <ol className="pn-steps">
          <li className={data.wireguardInstalled ? "done" : ""}>
            {data.wireguardInstalled ? <Check size={15} /> : <span>1</span>}
            <span>
              <strong>Install WireGuard on this computer</strong>
              <small>{data.wireguardInstalled ? "Installed." : <>Free and open source. <a href="https://www.wireguard.com/install/" target="_blank" rel="noreferrer">Download WireGuard for Windows <ExternalLink size={12} /></a>, install it, then come back here.</>}</small>
            </span>
          </li>
          <li>
            <span>2</span>
            <span>
              <strong>Press Set up</strong>
              <small>Nexus creates the keys, starts the private network, opens the firewall and asks your router to forward one port.</small>
            </span>
          </li>
          <li>
            <span>3</span>
            <span>
              <strong>Add your phone or laptop</strong>
              <small>Install the WireGuard app on it and scan the QR code Nexus shows.</small>
            </span>
          </li>
        </ol>
      )}

      {data.enabled && (
        <>
          <div className={`pn-router ${data.router.status}`}>
            {data.router.status === "forwarded" ? <ShieldCheck size={18} /> : <TriangleAlert size={18} />}
            <span>
              <strong>{data.router.status === "forwarded" ? "Reachable from anywhere" : data.router.status === "shared_address" ? "Only works at home for now" : data.router.status === "manual" ? "One router setting needed" : "Checking your router…"}</strong>
              <small>{data.router.message || `Devices connect to UDP port ${data.port}.`}</small>
            </span>
            {canManage && data.router.status !== "forwarded" && (
              <button className="btn small" disabled={busy !== null} onClick={() => void act("router", () => post("/network/private/router"))}>{busy === "router" ? <Spinner label="Checking…" /> : "Check again"}</button>
            )}
          </div>

          <div className="pn-devices">
            <div className="row">
              <strong>Devices</strong>
              <span className="spacer" />
              {canManage && <button className="btn small" onClick={() => setAdding({ name: "", result: null })}><Plus size={14} /> Add device</button>}
            </div>
            {!data.devices.length && <p className="small muted">No devices yet. Add your phone first.</p>}
            {data.devices.map((d) => (
              <div className="pn-device" key={d.id}>
                {/phone|mobile|iphone|android/i.test(d.name) ? <Smartphone size={17} /> : <Laptop size={17} />}
                <span>
                  <strong>{d.name}</strong>
                  <small>{ago(d.lastSeen)} · {d.address}</small>
                </span>
                {canManage && (
                  <button className="btn ghost small danger" aria-label={`Remove ${d.name}`} disabled={busy !== null} onClick={() => confirm(`Remove ${d.name}? It will no longer be able to connect.`) && void act(`rm-${d.id}`, () => del(`/network/private/devices/${d.id}`))}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {(data.controlCenterUrl || data.apps.length > 0) && (
            <div className="pn-links">
              <strong>Addresses on your devices (while WireGuard is on)</strong>
              {data.controlCenterUrl && <span><small>Nexus control center</small><code>{data.controlCenterUrl}</code></span>}
              {data.apps.map((a) => <span key={a.appId}><small>{a.name}</small><code>{a.url}</code></span>)}
              <small className="muted">The control center still asks for your password and two-step code.</small>
            </div>
          )}

          {canManage && (
            <details className="pn-advanced">
              <summary className="small">Advanced</summary>
              <label className="field">
                Address devices use
                <span className="hint">Leave empty to use this network's public address. Enter a domain name if that address changes often.</span>
                <input className="input" placeholder="Automatic" value={endpoint ?? data.endpointHost ?? ""} onChange={(e) => setEndpoint(e.target.value)} />
              </label>
              <div className="row">
                <button className="btn small" disabled={endpoint === null || busy !== null} onClick={() => void act("endpoint", async () => { await put("/network/private/settings", { endpointHost: endpoint?.trim() || null }); setEndpoint(null); })}>Save</button>
                <span className="spacer" />
                <button className="btn small danger" disabled={busy !== null} onClick={() => confirm("Switch the private network off? Devices can't connect until you switch it on again.") && void act("disable", () => post("/network/private/disable"))}>Switch off</button>
              </div>
            </details>
          )}
        </>
      )}
      <ErrorNote error={err} />

      {adding && (
        <Modal
          title={adding.result ? `Connect ${adding.result.device.name}` : "Add a device"}
          onClose={() => setAdding(null)}
          footer={
            adding.result ? (
              <button className="btn primary" onClick={() => setAdding(null)}>Done</button>
            ) : (
              <>
                <button className="btn" onClick={() => setAdding(null)}>Cancel</button>
                <button
                  className="btn primary"
                  disabled={!adding.name.trim() || busy !== null}
                  onClick={() => void act("add", async () => setAdding({ ...adding, result: await post<{ device: { name: string }; config: string }>("/network/private/devices", { name: adding.name }) }))}
                >
                  {busy === "add" ? <Spinner label="Adding…" /> : "Add"}
                </button>
              </>
            )
          }
        >
          {!adding.result ? (
            <label className="field">
              Device name
              <input className="input" autoFocus placeholder="My phone" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} maxLength={60} />
            </label>
          ) : (
            <div className="pn-connect">
              <QrCode text={adding.result.config} />
              <ol className="small">
                <li>Install the <strong>WireGuard</strong> app on the device (App Store, Google Play, or wireguard.com for laptops).</li>
                <li>Phone: tap <strong>+</strong> → <strong>Scan from QR code</strong>. Laptop: download the file below and choose <strong>Import tunnel from file</strong>.</li>
                <li>Switch the tunnel on. That's it.</li>
              </ol>
              <a
                className="btn small"
                download={`${adding.result.device.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "nexus"}.conf`}
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(adding.result.config)}`}
              >
                <Download size={14} /> Download file for a laptop
              </a>
              <small className="muted">This code contains the device's secret key and is shown only once. If you lose it, remove the device and add it again.</small>
            </div>
          )}
        </Modal>
      )}
    </Card>
  );
}
