import { useState } from "react";
import { BRAND } from "@nexus/shared/brand";
import { ApiError, post } from "../lib/api";

/** Password (+ two-step code) sign-in, used for remote administration and additional users. */
export function SignIn({ onDone, sessionEnded = false, desktop = false }: { onDone: () => void; sessionEnded?: boolean; desktop?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (pending) {
        await post("/auth/mfa", { pendingToken: pending, code });
        onDone();
      } else {
        const r = await post<{ ok?: boolean; mfaRequired?: boolean; pendingToken?: string }>("/auth/login", { username, password });
        if (r.mfaRequired) setPending(r.pendingToken!);
        else onDone();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Nexus couldn't be reached.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card stack" style={{ width: "min(380px, 100%)" }} onSubmit={submit}>
        <div>
          <h1>{BRAND.productName}</h1>
          <p className="secondary" style={{ marginTop: 4 }}>
            {pending
              ? "Enter the 6-digit code from your authenticator app."
              : sessionEnded
                ? "Your session ended. Sign in again to continue."
                : "Sign in to manage this server."}
          </p>
        </div>
        {desktop && !pending && (
          <>
            <button
              className="btn primary large"
              type="button"
              onClick={() => location.replace("http://tauri.localhost/index.html")}
            >
              Continue on this computer
            </button>
            <p className="small muted" style={{ textAlign: "center" }}>
              or sign in with a Nexus account
            </p>
          </>
        )}
        {!pending ? (
          <>
            <label className="field">
              Username
              <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
            </label>
            <label className="field">
              Password
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          </>
        ) : (
          <label className="field">
            Verification code
            <input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
          </label>
        )}
        {error && (
          <div className="notice" role="alert" style={{ color: "var(--critical-text)" }}>
            {error}
          </div>
        )}
        <button className={`btn ${desktop && !pending ? "" : "primary"} large`} disabled={busy}>
          {pending ? "Verify" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
