import { Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { DatabaseSummary } from "@nexus/shared/contracts";
import { ApiError, del } from "../lib/api";
import { Card, ConfirmByName, ErrorNote } from "./ui";

/**
 * Deletes a database for good: its tables or documents and its logins. Refused while an
 * application still uses it (remove the application first). Application backups are kept.
 */
export function DeleteDatabase({ database, kind }: { database: DatabaseSummary; kind: "tables" | "documents" }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const usedBy = database.usedBy ?? [];
  const path = kind === "documents" ? `/documents/${database.id}` : `/databases/${database.id}`;

  return (
    <Card title="Delete database" sub="Permanently removes this database and everything in it.">
      {usedBy.length > 0 ? (
        <div className="delete-db-blocked">
          <TriangleAlert size={17} />
          <span>
            <strong>In use by {usedBy.map((a, i) => <span key={a.id}>{i > 0 && ", "}<Link to={`/apps/${a.id}`}>{a.name}</Link></span>)}</strong>
            <small className="muted">Remove {usedBy.length === 1 ? "that application" : "those applications"} first (app → Overview → Remove), then you can delete this database.</small>
          </span>
        </div>
      ) : (
        <button className="btn danger" onClick={() => setOpen(true)}><Trash2 size={16} /> Delete {database.name}</button>
      )}
      <ErrorNote error={error} />
      {open && (
        <ConfirmByName
          name={database.name}
          action="Delete Database"
          onClose={() => setOpen(false)}
          onConfirm={() =>
            void del(path, { confirmation: database.name })
              .then(() => navigate("/databases"))
              .catch((e) => {
                setOpen(false);
                setError(e as ApiError);
              })
          }
        >
          <p>
            This permanently deletes <strong>{database.name}</strong> and all its {kind === "documents" ? "collections and documents" : "tables and rows"}. It can't be undone.
            Backups made for applications that used it are kept.
          </p>
        </ConfirmByName>
      )}
    </Card>
  );
}
