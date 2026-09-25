import { ArrowRight, Check, Cpu, HardDrive, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { BRAND } from "@nexus/shared/brand";
import { formatBytes } from "@nexus/shared/format";
import type { HardwareProfile } from "@nexus/shared/contracts";
import { ApiError, get, post } from "../lib/api";
import { ErrorNote, Modal, Status } from "../components/ui";

type Step = "welcome" | "check" | "recommend" | "applying" | "ready";

interface Check {
  key: string;
  label: string;
  level: "ok" | "warning" | "problem";
  summary: string;
}
interface DriveOption {
  mount: string;
  label: string;
  media: string;
  external: boolean;
  freeBytes: number;
  totalBytes: number;
  suitability: "recommended" | "good" | "not_recommended";
  note: string;
}
type PathKey = "apps" | "database" | "files" | "backups" | "ai";
interface Recommendation {
  paths: Record<PathKey, string>;
  ai: { enabled: boolean; label: string; model: string; acceleration: string };
  notes: string[];
  drives: Record<Exclude<PathKey, "ai">, DriveOption[]>;
}

const PATH_LABELS: Record<PathKey, string> = {
  apps: "Application Storage",
  database: "Database Storage",
  files: "File Storage",
  backups: "Backup Location",
  ai: "AI Models",
};

export function FirstRun({ onDone }: { onDone: (next: string) => void }) {
  const initial = (new URLSearchParams(location.search).get("step") as Step | null) ?? "welcome";
  const [step, setStep] = useState<Step>(initial);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [shown, setShown] = useState(0);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [paths, setPaths] = useState<Record<PathKey, string> | null>(null);
  const [picking, setPicking] = useState<Exclude<PathKey, "ai"> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // "Checking your computer..." — run the real detection, reveal results one by one.
  useEffect(() => {
    if (step !== "check") return;
    let cancelled = false;
    setChecks(null);
    setShown(0);
    post<{ hardware: HardwareProfile; checks: Check[] }>("/setup/check")
      .then((r) => {
        if (cancelled) return;
        setHardware(r.hardware);
        setChecks(r.checks);
      })
      .catch((e) => setError(e));
    return () => {
      cancelled = true;
    };
  }, [step]);

  useEffect(() => {
    if (!checks || shown >= checks.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), 220);
    return () => clearTimeout(t);
  }, [checks, shown]);

  useEffect(() => {
    if (step !== "recommend") return;
    get<Recommendation>("/setup/recommendation")
      .then((r) => {
        setRec(r);
        setPaths(r.paths);
      })
      .catch((e) => setError(e));
  }, [step]);

  async function apply() {
    setStep("applying");
    setError(null);
    try {
      await post("/setup/apply", { paths, aiEnabled: rec?.ai.enabled ?? true });
      setStep("ready");
    } catch (e) {
      setError(e as ApiError);
      setStep("recommend");
    }
  }

  return (
    <div className="center-screen">
      <div className="wizard fade-in" key={step}>
        {step === "welcome" && (
          <div className="card stack" style={{ padding: 40, textAlign: "center", alignItems: "center" }}>
            <span className="brand-mark" style={{ width: 56, height: 56, borderRadius: 16 }}>
              <Sparkles size={28} />
            </span>
            <h1 style={{ fontSize: 30 }}>Welcome to {BRAND.shortName}.</h1>
            <p className="secondary" style={{ fontSize: 16, maxWidth: 480 }}>
              {BRAND.tagline}
            </p>
            <p className="secondary" style={{ maxWidth: 480 }}>
              {BRAND.shortName} will automatically configure your applications, databases, storage, security, AI, and remote access.
            </p>
            <button className="btn primary large" style={{ marginTop: 8 }} onClick={() => setStep("check")}>
              Get Started <ArrowRight size={18} />
            </button>
          </div>
        )}

        {step === "check" && (
          <div className="card stack" style={{ padding: 32 }}>
            <div className="row">
              <Cpu size={22} />
              <h1>{checks && shown >= checks.length ? "Your computer is ready" : "Checking your computer…"}</h1>
            </div>
            {!checks && !error && (
              <p className="secondary row">
                <Loader2 size={16} className="spin" /> Looking at the processor, memory, drives, graphics and network.
              </p>
            )}
            <ErrorNote error={error} />
            {checks && (
              <div className="list">
                {checks.slice(0, shown).map((c) => (
                  <div key={c.key} className="list-item fade-in">
                    <span style={{ width: 150, fontWeight: 600 }}>{c.label}</span>
                    <span className="secondary" style={{ flex: 1 }}>
                      {c.summary}
                    </span>
                    <Status tone={c.level === "ok" ? "good" : c.level === "warning" ? "warning" : "critical"}>{c.level === "ok" ? "Ready" : c.level === "warning" ? "Note" : "Problem"}</Status>
                  </div>
                ))}
              </div>
            )}
            {hardware && checks && shown >= checks.length && (
              <div className="notice fade-in">
                <strong>AI Acceleration: </strong>
                {hardware.cuda.available ? `CUDA available on ${hardware.gpus.find((g) => g.vendor === "nvidia")?.name ?? "your GPU"}` : "CPU Mode"}. Recommended configuration will be applied automatically.
              </div>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn primary large" disabled={!checks || shown < checks.length} onClick={() => setStep("recommend")}>
                Continue <ArrowRight size={18} />
              </button>
            </div>
          </div>
        )}

        {(step === "recommend" || step === "applying") && (
          <div className="card stack" style={{ padding: 32 }}>
            <h1>Recommended Configuration</h1>
            <p className="secondary">Chosen for this computer. You can change a location, but you don't need to.</p>
            <ErrorNote error={error} />
            {!rec || !paths ? (
              <p className="secondary row">
                <Loader2 size={16} className="spin" /> Working out the best setup…
              </p>
            ) : (
              <>
                <div className="list">
                  {(Object.keys(PATH_LABELS) as PathKey[]).map((k) => (
                    <div key={k} className="list-item">
                      <HardDrive size={18} className="muted" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{PATH_LABELS[k]}</div>
                        <div className="mono secondary" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                          {paths[k]}
                        </div>
                      </div>
                      {k !== "ai" && (
                        <button className="btn ghost small" disabled={step === "applying"} onClick={() => setPicking(k)}>
                          Change
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="list-item">
                    <Sparkles size={18} className="muted" />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>AI</div>
                      <div className="secondary">{rec.ai.label}</div>
                    </div>
                  </div>
                </div>
                {rec.notes.map((n) => (
                  <div key={n} className="notice">
                    {n}
                  </div>
                ))}
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button className="btn primary large" disabled={step === "applying"} onClick={apply}>
                    {step === "applying" ? (
                      <>
                        <Loader2 size={18} className="spin" /> Setting up your server…
                      </>
                    ) : (
                      <>
                        <Check size={18} /> Use Recommended Configuration
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {step === "ready" && (
          <div className="card stack" style={{ padding: 40, textAlign: "center", alignItems: "center" }}>
            <span style={{ color: "var(--good)" }}>
              <Check size={48} />
            </span>
            <h1 style={{ fontSize: 28 }}>Your server is ready.</h1>
            <p className="secondary">Databases, storage, backups and secure access are set up and waiting for your first application.</p>
            <button className="btn primary large" onClick={() => onDone("/apps/new")}>
              Add Your First Application <ArrowRight size={18} />
            </button>
            <button className="btn ghost" onClick={() => onDone("/")}>
              Go to the dashboard
            </button>
          </div>
        )}
      </div>

      {picking && rec && paths && (
        <DrivePicker
          role={picking}
          options={rec.drives[picking]}
          current={paths[picking]}
          onClose={() => setPicking(null)}
          onPick={(mount) => {
            const suffix = paths[picking].slice(3);
            setPaths({ ...paths, [picking]: `${mount}${suffix}` });
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

function DrivePicker({ role, options, current, onPick, onClose }: { role: Exclude<PathKey, "ai">; options: DriveOption[]; current: string; onPick: (mount: string) => void; onClose: () => void }) {
  return (
    <Modal title={`Choose a drive for ${PATH_LABELS[role].toLowerCase()}`} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        {options.map((o) => (
          <button key={o.mount} className={`choice ${current.startsWith(o.mount) ? "selected" : ""}`} onClick={() => onPick(o.mount)}>
            <HardDrive size={22} />
            <div style={{ flex: 1 }}>
              <div className="title">
                {o.mount} {o.label && <span className="secondary">— {o.label}</span>}
              </div>
              <div className="desc">
                {formatBytes(o.freeBytes)} free of {formatBytes(o.totalBytes)} · {o.media === "nvme" ? "NVMe SSD" : o.media === "ssd" ? "SSD" : o.media === "hdd" ? "Hard disk" : "Drive"}
                {o.external ? " · External" : ""}
              </div>
              <div className="desc">{o.note}</div>
            </div>
            <Status tone={o.suitability === "recommended" ? "good" : o.suitability === "good" ? "neutral" : "warning"}>
              {o.suitability === "recommended" ? "Recommended" : o.suitability === "good" ? "OK" : "Not ideal"}
            </Status>
          </button>
        ))}
      </div>
    </Modal>
  );
}
