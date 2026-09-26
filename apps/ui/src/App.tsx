import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ApiError, get, post } from "./lib/api";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { SignIn } from "./pages/SignIn";
import { FirstRun } from "./pages/FirstRun";
import { Dashboard } from "./pages/Dashboard";
import { AddApplication } from "./pages/AddApplication";
import { Applications } from "./pages/Applications";
import { ApplicationDetail } from "./pages/ApplicationDetail";
import { Databases } from "./pages/Databases";
import { DatabaseDetail } from "./pages/DatabaseDetail";
import { Blueprint } from "./pages/Blueprint";
import { DocumentDatabaseDetail } from "./pages/DocumentDatabaseDetail";
import { Backups } from "./pages/Backups";
import { Ai } from "./pages/Ai";
import { Settings } from "./pages/Settings";
import { NewPipeline, Pipelines } from "./pages/Pipelines";
import { PipelineDetail } from "./pages/PipelineDetail";
import { PipelineRun } from "./pages/PipelineRun";

export interface Me {
  user: { id: string; username: string; displayName: string; role: string; mfaEnabled: boolean; appRoles: Record<string, string> };
  permissions: string[];
  remote: boolean;
  setupCompleted: boolean;
}

/**
 * Desktop app opens http://127.0.0.1:7780/?local=<token>; the token (read from a file only
 * administrators can see) signs the Owner in, then disappears from the address bar.
 */
async function exchangeLocalToken(): Promise<void> {
  const url = new URL(location.href);
  const token = url.searchParams.get("local");
  if (!token) return;
  url.searchParams.delete("local");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  try {
    await post("/auth/local", { token });
  } catch {
    /* fall through to normal sign-in */
  }
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "signin" | "ready">("loading");

  const load = useCallback(async () => {
    try {
      setMe(await get<Me>("/auth/me"));
      setState("ready");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setState("signin");
      else setTimeout(load, 2000); // service still starting
    }
  }, []);

  useEffect(() => {
    void exchangeLocalToken().then(load);
  }, [load]);

  if (state === "loading")
    return (
      <div className="center-screen">
        <Spinner label="Connecting to your server…" />
      </div>
    );
  if (state === "signin" || !me) return <SignIn onDone={load} />;
  if (!me.setupCompleted && me.permissions.includes("server.settings")) {
    return (
      <FirstRun
        onDone={(next) => {
          history.replaceState(null, "", next);
          void load();
        }}
      />
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="*"
          element={
            <Layout me={me}>
              <Routes>
                <Route path="/" element={<Dashboard canCreateApps={me.permissions.includes("apps.create")} canUseAi={me.permissions.includes("ai.use")} />} />
                <Route path="/apps/new" element={me.permissions.includes("apps.create") ? <AddApplication /> : <Navigate to="/" replace />} />
                <Route path="/apps/:id" element={<ApplicationDetail me={me} />} />
                <Route path="/apps" element={<Applications canCreate={me.permissions.includes("apps.create")} />} />
                <Route path="/databases/:id" element={<DatabaseDetail me={me} />} />
                <Route path="/documents/:id" element={<DocumentDatabaseDetail me={me} />} />
                <Route path="/databases/:id/blueprint" element={<Blueprint kind="tables" />} />
                <Route path="/documents/:id/blueprint" element={<Blueprint kind="documents" />} />
                <Route path="/databases" element={<Databases canCreate={me.permissions.includes("databases.create")} />} />
                <Route path="/backups" element={<Backups me={me} />} />
                {me.permissions.includes("pipelines.view") && (
                  <>
                    <Route path="/pipelines" element={<Pipelines me={me} />} />
                    <Route path="/pipelines/new" element={me.permissions.includes("pipelines.edit") ? <NewPipeline /> : <Navigate to="/pipelines" replace />} />
                    <Route path="/pipelines/new/custom" element={me.permissions.includes("pipelines.edit") ? <PipelineDetail me={me} /> : <Navigate to="/pipelines" replace />} />
                    <Route path="/pipelines/:id" element={<PipelineDetail me={me} />} />
                    <Route path="/pipelines/:id/runs/:runId" element={<PipelineRun me={me} />} />
                  </>
                )}
                <Route path="/ai" element={me.permissions.includes("ai.use") ? <Ai me={me} /> : <Navigate to="/" replace />} />
                <Route path="/settings/*" element={<Settings me={me} />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
