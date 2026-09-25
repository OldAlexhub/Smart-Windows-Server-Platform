import { ArrowRight, Box, Plus } from "lucide-react";
import { Link } from "react-router";
import { formatBytes } from "@nexus/shared/format";
import type { AppSummary } from "@nexus/shared/contracts";
import { PageHead } from "../components/Layout";
import { Empty, ErrorNote, Spinner, StatusOf } from "../components/ui";
import { useApi } from "../lib/hooks";

export function Applications({ canCreate }: { canCreate: boolean }) {
  const { data, error, loading } = useApi<AppSummary[]>("/apps", 10_000);
  return (
    <>
      <PageHead title="Applications" sub="Projects running on this server." actions={canCreate && <Link to="/apps/new" className="btn primary"><Plus size={17} /> Add Application</Link>} />
      {loading && !data ? <div className="center-panel"><Spinner label="Loading applications…" /></div> : error && !data ? <ErrorNote error={error} /> : !data?.length ? (
        <Empty icon={<Box size={34} />} title="No applications yet" action={canCreate && <Link to="/apps/new" className="btn primary">Add Your First Application</Link>}>Choose a project folder and Nexus will deploy it for you.</Empty>
      ) : (
        <div className="app-card-grid">
          {data.map((app) => (
            <Link to={`/apps/${app.id}`} className="card app-card" key={app.id}>
              <div className="app-card-head"><span className="app-avatar">{app.name.slice(0, 1).toUpperCase()}</span><StatusOf status={app.status} /></div>
              <h2>{app.name}</h2>
              <p className="secondary">{app.framework || app.runtime}</p>
              <div className="app-card-metrics"><span><strong className="num">{app.cpuPercent.toFixed(0)}%</strong><small>CPU</small></span><span><strong className="num">{formatBytes(app.memoryBytes)}</strong><small>Memory</small></span><span><strong className="num">{formatBytes(app.storageBytes)}</strong><small>Storage</small></span></div>
              <div className="row small"><span className="muted">{app.externalUrl ? "External access on" : "Private"}</span><span className="spacer" /><span className="row">Open <ArrowRight size={14} /></span></div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
