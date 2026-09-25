import { PageHead } from "../components/Layout";
import { Card, Meter, Stat, Status } from "../components/ui";

/** Temporary scaffold page showing the design primitives (replaced as each screen is built). */
export function Placeholder({ title }: { title: string }) {
  return (
    <>
      <PageHead title={title} sub="Design system preview" actions={<button className="btn primary">Primary action</button>} />
      <div className="grid grid-4">
        <Stat label="System Health" value="98%" sub="Healthy" />
        <Stat label="Memory" value="24 / 64 GB">
          <Meter value={0.375} label="Memory used" />
        </Stat>
        <Stat label="Applications" value="7" sub="7 running" />
        <Stat label="Storage" value="2.1 / 8 TB">
          <Meter value={0.26} label="Storage used" />
        </Stat>
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title="Statuses" sub="Icon + word + colour">
          <div className="stack">
            <Status tone="good">Running</Status>
            <Status tone="warning">Needs Attention</Status>
            <Status tone="serious">Backups out of date</Status>
            <Status tone="critical">Stopped unexpectedly</Status>
            <Status tone="neutral">Stopped</Status>
          </div>
        </Card>
        <Card title="Buttons">
          <div className="row">
            <button className="btn primary">Deploy</button>
            <button className="btn">Restart</button>
            <button className="btn danger">Remove</button>
            <button className="btn ghost">Advanced</button>
          </div>
        </Card>
      </div>
    </>
  );
}
