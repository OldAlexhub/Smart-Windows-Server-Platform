import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Database,
  FileCode2,
  Folder,
  FolderOpen,
  Globe2,
  HardDrive,
  KeyRound,
  Loader2,
  Lock,
  Network,
  Play,
  Server,
  ShieldCheck,
  TerminalSquare,
  TestTube2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { AccessMode, AppSummary, JobStep } from "@nexus/shared/contracts";
import type { FriendlyProblem } from "@nexus/shared/errors";
import { Card, ErrorNote, ProblemCard, Spinner, Status } from "../components/ui";
import { ApiError, get, post } from "../lib/api";
import { useJob } from "../lib/hooks";

type Stage = "folder" | "analysis" | "data" | "access" | "deploy" | "ready";

interface BrowseResult {
  path: string | null;
  parent: string | null;
  isProject?: boolean;
  entries: { name: string; path: string; isProject: boolean }[];
}

interface AnalysisResult {
  name: string;
  summary: string;
  findings: string[];
  database: { required: boolean; kind: string | null; evidence: string[] };
  storage: { required: boolean; directories?: string[]; evidence?: string[] };
  externalAccessRecommended: boolean;
  /** Settings › Domains › Base domain, if set: new apps get <app>.<base domain>. */
  baseDomain?: string | null;
  settingsNeeded: string[];
  warnings: string[];
  existingDatabases: { id: string; name: string }[];
  analysis: { components: unknown[] };
}

type DataChoice =
  | { mode: "new"; databaseName?: string }
  | { mode: "existing"; databaseId: string }
  | { mode: "external"; externalUrl: string }
  | { mode: "none" };

interface DeployResult {
  appId: string;
  release: string;
  summary: AppSummary;
  checks: { label: string; ok: boolean; detail: string }[];
}

const stages: { key: Stage; label: string }[] = [
  { key: "folder", label: "Folder" },
  { key: "analysis", label: "Analysis" },
  { key: "data", label: "Data" },
  { key: "access", label: "Access" },
  { key: "deploy", label: "Deploy" },
  { key: "ready", label: "Ready" },
];

function WizardSteps({ stage }: { stage: Stage }) {
  const current = stages.findIndex((s) => s.key === stage);
  return (
    <ol className="wizard-steps" aria-label="Add application progress">
      {stages.map((s, i) => (
        <li key={s.key} className={i < current ? "done" : i === current ? "active" : ""} aria-current={i === current ? "step" : undefined}>
          <span className="wizard-step-dot">{i < current ? <Check size={13} /> : i + 1}</span>
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function WizardHead({ title, sub }: { title: string; sub: string }) {
  return <div className="wizard-head"><h1>{title}</h1><p>{sub}</p></div>;
}

function Choice({ selected, icon, title, description, onClick, children }: { selected: boolean; icon: React.ReactNode; title: string; description: string; onClick: () => void; children?: React.ReactNode }) {
  return (
    <div className={`choice wizard-choice ${selected ? "selected" : ""}`} role="radio" aria-checked={selected} tabIndex={0} onClick={onClick} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}>
      <span className="choice-icon">{icon}</span>
      <span className="choice-copy"><span className="title">{title}</span><span className="desc">{description}</span>{children}</span>
      <span className="radio-dot">{selected && <span />}</span>
    </div>
  );
}

function FolderStep({ onAnalyzed }: { onAnalyzed: (path: string, result: AnalysisResult) => void }) {
  const [browser, setBrowser] = useState<BrowseResult | null>(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function browse(next?: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await get<BrowseResult>(`/fs/browse${next ? `?path=${encodeURIComponent(next)}` : ""}`);
      setBrowser(result);
      if (result.path) setPath(result.path);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 0, "network", null));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void browse(); }, []);

  async function analyze(selected = path) {
    if (!selected.trim()) return;
    setAnalyzing(true);
    setError(null);
    try {
      const result = await post<AnalysisResult>("/apps/analyze", { path: selected.trim() });
      onAnalyzed(selected.trim(), result);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 0, "network", null));
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <>
      <WizardHead title="Choose your application folder" sub="Pick the folder that contains package.json, requirements.txt, pyproject.toml, or index.html." />
      <Card>
        <label className="field">
          Folder on this computer
          <span className="folder-path-input"><FolderOpen size={17} /><input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Projects\MyApplication" /></span>
        </label>
        <div className="folder-browser" aria-label="Folder browser">
          <div className="folder-browser-head">
            {browser?.path && <button className="btn ghost small" onClick={() => void browse(browser.parent ?? undefined)}><ArrowLeft size={15} /> Up</button>}
            <span className="mono small">{browser?.path ?? "This computer"}</span>
            <span className="spacer" />
            {browser?.isProject && <Status tone="good">Application detected</Status>}
          </div>
          {loading ? <div className="folder-loading"><Spinner label="Opening folder…" /></div> : (
            <div className="folder-list">
              {browser?.entries.length ? browser.entries.map((entry) => (
                <div className="folder-row" key={entry.path}>
                  <button className="folder-open" onClick={() => void browse(entry.path)} title={`Open ${entry.name}`}>
                    {entry.isProject ? <FileCode2 size={18} /> : <Folder size={18} />}
                    <span>{entry.name}</span>
                    {entry.isProject && <span className="small muted">Application</span>}
                    <ChevronRight size={15} className="muted" />
                  </button>
                  {entry.isProject && <button className="btn small" onClick={() => { setPath(entry.path); void analyze(entry.path); }}>Choose</button>}
                </div>
              )) : <div className="folder-loading secondary">No folders found here.</div>}
            </div>
          )}
        </div>
        <ErrorNote error={error} />
        <div className="wizard-actions"><span className="spacer" /><button className="btn primary large" disabled={!path.trim() || analyzing} onClick={() => void analyze()}>{analyzing ? <Spinner label="Analyzing…" /> : <>Analyze Folder <ArrowRight size={17} /></>}</button></div>
      </Card>
    </>
  );
}

function AnalysisStep({ analysis, name, setName, onBack, onNext }: { analysis: AnalysisResult; name: string; setName: (n: string) => void; onBack: () => void; onNext: () => void }) {
  const recognized = analysis.analysis.components.length > 0;
  return (
    <>
      <WizardHead title="Here’s what Nexus found" sub="Review the result. Technical setup will be handled automatically." />
      <Card>
        <div className="analysis-summary">
          <span className="analysis-icon"><FileCode2 size={26} /></span>
          <div><h2>{analysis.summary || "Application"}</h2><p className="secondary">{recognized ? "Ready to configure" : "Choose the folder that directly contains the application"}</p></div>
          <Status tone={recognized ? "good" : "warning"}>{recognized ? "Recognized" : "Not recognized"}</Status>
        </div>
        <label className="field" style={{ marginTop: 20 }}>Application name<input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <div className="finding-grid">
          {analysis.findings.map((finding) => <div className="finding" key={finding}><CheckCircle2 size={17} /> <span>{finding}</span></div>)}
        </div>
        {analysis.settingsNeeded.length > 0 && <div className="notice row" style={{ marginTop: 16 }}><KeyRound size={18} /><span><strong>{analysis.settingsNeeded.length} private {analysis.settingsNeeded.length === 1 ? "setting" : "settings"} needed.</strong> You can enter {analysis.settingsNeeded.join(", ")} securely after deployment.</span></div>}
        {analysis.warnings.map((warning) => <div className="notice row" style={{ marginTop: 10 }} key={warning}><TriangleAlert size={18} />{warning}</div>)}
        <div className="wizard-actions"><button className="btn" onClick={onBack}><ArrowLeft size={16} /> Choose another folder</button><span className="spacer" /><button className="btn primary large" disabled={!recognized || !name.trim()} onClick={onNext}>Continue <ArrowRight size={17} /></button></div>
      </Card>
    </>
  );
}

function DataStep({ analysis, choice, setChoice, onBack, onNext }: { analysis: AnalysisResult; choice: DataChoice; setChoice: (c: DataChoice) => void; onBack: () => void; onNext: () => void }) {
  const needed = analysis.database.required;
  const existing = analysis.existingDatabases;
  const valid = choice.mode === "existing" ? !!choice.databaseId : choice.mode === "external" ? !!choice.externalUrl.trim() : true;
  return (
    <>
      <WizardHead title="Set up application data" sub={needed ? "A database was detected. Nexus recommends a new, isolated database for this application." : existing.length ? "No database requirement was detected. You can still connect one of your current databases if this application uses it." : "No database requirement was detected, so no database is needed."} />
      <Card>
        <div className="choice-stack" role="radiogroup" aria-label="Database choice">
          {needed && <Choice selected={choice.mode === "new"} icon={<Database size={21} />} title="Create a new database" description="Recommended · Nexus creates it, secures it, connects the app, and backs it up." onClick={() => setChoice({ mode: "new" })} />}
          {existing.length > 0 && <Choice selected={choice.mode === "existing"} icon={<Server size={21} />} title="Use an existing Nexus database" description="Give this application its own secure access to a database already on this server." onClick={() => setChoice({ mode: "existing", databaseId: choice.mode === "existing" ? choice.databaseId : existing[0]!.id })}>{choice.mode === "existing" && <select className="select nested-control" value={choice.databaseId} onClick={(e) => e.stopPropagation()} onChange={(e) => setChoice({ mode: "existing", databaseId: e.target.value })}>{existing.map((db) => <option value={db.id} key={db.id}>{db.name}</option>)}</select>}</Choice>}
          {needed && <Choice selected={choice.mode === "external"} icon={<Network size={21} />} title="Connect an external database" description="Use a PostgreSQL database managed somewhere else." onClick={() => setChoice({ mode: "external", externalUrl: choice.mode === "external" ? choice.externalUrl : "" })}>{choice.mode === "external" && <label className="field nested-control">Connection address<input className="input mono" type="password" autoComplete="off" placeholder="postgresql://…" value={choice.externalUrl} onClick={(e) => e.stopPropagation()} onChange={(e) => setChoice({ mode: "external", externalUrl: e.target.value })} /><span className="hint">Encrypted in the Nexus vault and never shown again.</span></label>}</Choice>}
          <Choice selected={choice.mode === "none"} icon={<HardDrive size={21} />} title={needed ? "This application doesn’t need a database" : "No database"} description={needed ? "Choose this only if the detected database settings are unused." : "Nexus will deploy the application without database credentials."} onClick={() => setChoice({ mode: "none" })} />
        </div>
        {analysis.storage.required && <div className="notice row" style={{ marginTop: 16 }}><ShieldCheck size={18} /><span><strong>File storage detected.</strong> Nexus will create a private upload area and connect it automatically.</span></div>}
        <div className="wizard-actions"><button className="btn" onClick={onBack}><ArrowLeft size={16} /> Back</button><span className="spacer" /><button className="btn primary large" disabled={!valid} onClick={onNext}>Continue <ArrowRight size={17} /></button></div>
      </Card>
    </>
  );
}

const accessChoices: { mode: AccessMode; icon: React.ReactNode; title: string; description: string }[] = [
  { mode: "private", icon: <Lock size={21} />, title: "Private to this computer", description: "Safest default · available only on this server." },
  { mode: "internet", icon: <Globe2 size={21} />, title: "Public website", description: "Anyone with the address can reach the application over HTTPS." },
  { mode: "authorized", icon: <ShieldCheck size={21} />, title: "Authorized users only", description: "Visitors sign in with a Nexus account before access." },
  { mode: "api", icon: <KeyRound size={21} />, title: "API access only", description: "Requests need an API key; browser access is blocked." },
];

function AccessStep({ access, setAccess, domain, setDomain, recommended, onBack, onDeploy, deploying }: { access: AccessMode; setAccess: (a: AccessMode) => void; domain: string; setDomain: (d: string) => void; recommended: boolean; onBack: () => void; onDeploy: () => void; deploying: boolean }) {
  const needsDomain = access !== "private";
  return (
    <>
      <WizardHead title="Choose who can access it" sub="Nexus keeps internal services private and handles HTTPS automatically." />
      <Card>
        <div className="choice-stack" role="radiogroup" aria-label="Access mode">
          {accessChoices.map((item) => <Choice key={item.mode} selected={access === item.mode} icon={item.icon} title={`${item.title}${(item.mode === "private" && !recommended) || (item.mode === "internet" && recommended) ? " · Recommended" : ""}`} description={item.description} onClick={() => setAccess(item.mode)}>{item.mode === access && item.mode !== "private" && <label className="field nested-control">Domain name<input className="input" placeholder="app.example.com" value={domain} onClick={(e) => e.stopPropagation()} onChange={(e) => setDomain(e.target.value.trim())} /><span className="hint">Nexus will show the exact DNS change if it isn’t connected yet.</span></label>}</Choice>)}
        </div>
        <div className="deploy-summary"><CheckCircle2 size={18} /><span>Nexus will copy the application into an isolated release, install dependencies, configure data and access, start it, test it, and turn on daily backups.</span></div>
        <div className="wizard-actions"><button className="btn" onClick={onBack}><ArrowLeft size={16} /> Back</button><span className="spacer" /><button className="btn primary large" disabled={deploying || (needsDomain && !domain)} onClick={onDeploy}>{deploying ? <Spinner label="Starting…" /> : <><Play size={17} /> Deploy Application</>}</button></div>
      </Card>
    </>
  );
}

function JobStepView({ step }: { step: JobStep }) {
  const icon = step.status === "done" ? <Check size={16} /> : step.status === "failed" ? <XCircle size={16} /> : step.status === "running" ? <Loader2 size={16} className="spin" /> : step.status === "skipped" ? <Check size={16} /> : <Circle size={13} />;
  return <div className={`deploy-step ${step.status}`}><span className="deploy-step-icon">{icon}</span><span><strong>{step.label}</strong>{step.detail && <span className="small secondary">{step.detail}</span>}</span></div>;
}

function DeployStep({ jobId, appId, onReady }: { jobId: string; appId: string; onReady: (result: DeployResult) => void }) {
  const job = useJob(jobId);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (job?.status === "succeeded" && job.result) onReady(job.result as DeployResult);
  }, [job?.status, job?.result, onReady]);

  async function answer(questionId: string, value: string) {
    setAnswering(true);
    setError(null);
    try { await post(`/jobs/${jobId}/answer`, { questionId, value }); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(String(e), 0, "network", null)); }
    finally { setAnswering(false); }
  }

  return (
    <>
      <WizardHead title={job?.status === "failed" ? "Deployment needs attention" : "Setting up your application"} sub={job?.status === "waiting_for_input" ? "Nexus needs one answer to continue." : "You can leave this page; the server keeps working in the background."} />
      <Card>
        {!job ? <div className="folder-loading"><Spinner label="Starting deployment…" /></div> : (
          <>
            <div className="deploy-steps">{job.steps.map((step) => <JobStepView key={step.key} step={step} />)}</div>
            {job.question && <div className="job-question fade-in"><h2>{job.question.prompt}</h2><div className="choice-stack" style={{ marginTop: 12 }}>{job.question.choices.map((choice) => <button className="choice" disabled={answering} key={choice.value} onClick={() => void answer(job.question!.id, choice.value)}><Database size={19} /><span><span className="title">{choice.label}</span>{choice.description && <span className="desc">{choice.description}</span>}</span><ArrowRight size={16} className="spacer" /></button>)}</div></div>}
            {job.problem && <ProblemCard problem={job.problem} />}
            <ErrorNote error={error} />
            {job.log.length > 0 && <details className="deploy-log"><summary>Deployment details</summary><pre className="mono">{job.log.join("\n")}</pre></details>}
            {job.status === "failed" && <div className="wizard-actions"><span className="spacer" /><Link to={`/apps/${appId}`} className="btn">Open Application</Link></div>}
          </>
        )}
      </Card>
    </>
  );
}

function ReadyStep({ result }: { result: DeployResult }) {
  return (
    <div className="ready-card card fade-in">
      <span className="ready-icon"><Check size={34} /></span>
      <h1>{result.summary.name} is online</h1>
      <p className="secondary">Nexus deployed and tested the application successfully.</p>
      <div className="ready-address"><span><span className="small muted">Application address</span><a href={result.summary.externalUrl ?? result.summary.localUrl} target="_blank" rel="noreferrer">{result.summary.externalUrl ?? result.summary.localUrl}</a></span><Status tone="good">Running</Status></div>
      <div className="test-results">
        <h2><TestTube2 size={18} /> Final checks</h2>
        {result.checks.map((check) => <div className="test-row" key={check.label}>{check.ok ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}<span><strong>{check.label}</strong>{check.detail && <span className="small secondary">{check.detail}</span>}</span><Status tone={check.ok ? "good" : "warning"}>{check.ok ? "Passed" : "Review"}</Status></div>)}
      </div>
      <div className="row ready-actions"><Link className="btn primary large" to={`/apps/${result.appId}`}>Open Application <ArrowRight size={17} /></Link><Link className="btn large" to="/">Go to Dashboard</Link></div>
    </div>
  );
}

/** "Taxi Ops!" → "taxi-ops" (the same rule Nexus uses for application addresses). */
const hostLabel = (name: string) =>
  name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "") || "app";

export function AddApplication() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("folder");
  const [sourceDir, setSourceDir] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [name, setName] = useState("");
  const [data, setData] = useState<DataChoice>({ mode: "none" });
  const [access, setAccess] = useState<AccessMode>("private");
  const [typedDomain, setTypedDomain] = useState<string | null>(null);
  // Until the person types their own, the address follows the app name: projectone.example.com.
  const domain = typedDomain ?? (analysis?.baseDomain ? `${hostLabel(name)}.${analysis.baseDomain}` : "");
  const setDomain = (d: string) => setTypedDomain(d);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [job, setJob] = useState<{ jobId: string; appId: string } | null>(null);
  const [result, setResult] = useState<DeployResult | null>(null);

  const ready = useMemo(() => (r: DeployResult) => { setResult(r); setStage("ready"); }, []);

  function analyzed(path: string, found: AnalysisResult) {
    setSourceDir(path);
    setAnalysis(found);
    setName(found.name);
    setData(found.database.required ? { mode: "new" } : { mode: "none" });
    setAccess(found.externalAccessRecommended ? "internet" : "private");
    setStage("analysis");
  }

  async function deploy() {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await post<{ appId: string; jobId: string }>("/apps", { sourceDir, name: name.trim(), data, access, domain: access === "private" ? null : domain });
      setJob(created);
      setStage("deploy");
    } catch (e) {
      setCreateError(e instanceof ApiError ? e : new ApiError(String(e), 0, "network", null));
    } finally { setCreating(false); }
  }

  return (
    <div className="add-app-page">
      <div className="add-app-top"><button className="btn ghost" onClick={() => navigate(-1)}><ArrowLeft size={17} /> Exit</button><WizardSteps stage={stage} /><span className="wizard-top-spacer" /></div>
      <div className="add-app-content">
        {stage === "folder" && <FolderStep onAnalyzed={analyzed} />}
        {stage === "analysis" && analysis && <AnalysisStep analysis={analysis} name={name} setName={setName} onBack={() => setStage("folder")} onNext={() => setStage("data")} />}
        {stage === "data" && analysis && <DataStep analysis={analysis} choice={data} setChoice={setData} onBack={() => setStage("analysis")} onNext={() => setStage("access")} />}
        {stage === "access" && analysis && <><AccessStep access={access} setAccess={setAccess} domain={domain} setDomain={setDomain} recommended={analysis.externalAccessRecommended} onBack={() => setStage("data")} onDeploy={() => void deploy()} deploying={creating} /><ErrorNote error={createError} /></>}
        {stage === "deploy" && job && <DeployStep {...job} onReady={ready} />}
        {stage === "ready" && result && <ReadyStep result={result} />}
      </div>
    </div>
  );
}
