import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { ENV_UPLOAD_LIMIT, parseEnvUpload } from "@nexus/shared/env-file";
import { post } from "../lib/api";
import { ErrorNote, Spinner } from "./ui";

interface Preview { settings: { name: string; alreadySet: boolean }[]; skipped: string[] }
interface Props { appId?: string; disabled?: boolean; managed?: string[]; onApply: (content: string, values: Record<string, string>) => void | Promise<void> }

export function EnvFileUpload({ appId, disabled, managed = [], onApply }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{ name: string; content: string; values: Record<string, string>; preview: Preview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [note, setNote] = useState("");
  async function choose(file: File) {
    setBusy(true); setError(null); setNote(""); setDraft(null);
    try {
      if (file.size > ENV_UPLOAD_LIMIT) throw new Error("Choose an .env file smaller than 128 KB.");
      const content = await file.text(), values = parseEnvUpload(content);
      const skipped = Object.keys(values).filter((name) => managed.includes(name) || /^NEXUS_/i.test(name) || ["PORT", "HOST", "__PROTO__", "CONSTRUCTOR", "PROTOTYPE"].includes(name.toUpperCase()));
      for (const name of skipped) delete values[name];
      const preview: Preview = appId ? await post(`/apps/${appId}/env-file/upload`, { content, preview: true }) : { settings: Object.keys(values).map((name) => ({ name, alreadySet: false })), skipped };
      setDraft({ name: file.name, content, values, preview });
    } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  async function apply() {
    if (!draft) return;
    setBusy(true); setError(null);
    try {
      await onApply(draft.content, draft.values);
      setNote(`${draft.preview.settings.length} settings ${appId ? "saved" : "loaded for deployment"} from ${draft.name}.`);
      setDraft(null);
    } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  return <div style={{ margin: "16px 0" }}>
    <input ref={input} type="file" aria-label="Upload .env file" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void choose(file); }} />
    <button className="btn" disabled={disabled || busy} onClick={() => input.current?.click()}><Upload size={16} /> {busy ? "Reading settings…" : "Upload .env file"}</button>
    <p className="small muted">Choose an .env file from this computer. Review the setting names before applying it; secret values stay hidden.</p>
    {draft && <div className="notice">
      <strong>{draft.name} · {draft.preview.settings.length} settings</strong>
      <div className="row" style={{ flexWrap: "wrap", margin: "12px 0" }}>{draft.preview.settings.map((item) => <code key={item.name}>{item.name}{item.alreadySet ? " (replace)" : ""}</code>)}</div>
      {draft.preview.skipped.length > 0 && <p className="small muted">Managed or reserved settings skipped: {draft.preview.skipped.join(", ")}</p>}
      <div className="row"><button className="btn primary" disabled={disabled || busy || !draft.preview.settings.length} onClick={() => void apply()}>{busy ? <Spinner label="Saving…" /> : appId ? "Save uploaded settings" : "Use these settings"}</button><button className="btn ghost" disabled={busy} onClick={() => setDraft(null)}>Cancel</button></div>
    </div>}
    {note && <p className="small" role="status">{note}</p>}
    <ErrorNote error={error} />
  </div>;
}
