import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { post } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Status, type Tone } from "./ui";

interface Notification {
  id: string;
  at: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  link: string | null;
  read: boolean;
}

const TONE: Record<Notification["severity"], { tone: Tone; label: string }> = {
  info: { tone: "good", label: "Info" },
  warning: { tone: "warning", label: "Warning" },
  critical: { tone: "critical", label: "Problem" },
};

/** Bell with the unread count; opens the latest notifications. */
export function NotificationBell() {
  const { data, reload } = useApi<{ unread: number; items: Notification[] }>("/notifications?limit=15", 30_000);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => (document.removeEventListener("mousedown", close), document.removeEventListener("keydown", esc));
  }, [open]);
  const unread = data?.unread ?? 0;
  return (
    <div className="bell" ref={box}>
      <button className="btn ghost bell-button" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bell size={18} />
        {unread > 0 && <span className="bell-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="btn ghost small" onClick={() => void post("/notifications/read", {}).then(reload)}>Mark all as read</button>}
          </div>
          {!data?.items.length ? (
            <p className="small muted bell-empty">Nothing needs your attention.</p>
          ) : (
            <ul>
              {data.items.map((n) => {
                const body = (
                  <>
                    <Status tone={TONE[n.severity].tone}>{TONE[n.severity].label}</Status>
                    <strong>{n.title}</strong>
                    <span className="small secondary">{n.message}</span>
                    <small className="muted">{new Date(n.at).toLocaleString()}</small>
                  </>
                );
                const markRead = () => void post("/notifications/read", { id: n.id }).then(reload);
                return (
                  <li key={n.id} className={n.read ? "" : "unread"}>
                    {n.link ? <Link to={n.link} onClick={() => (markRead(), setOpen(false))}>{body}</Link> : <div onClick={markRead}>{body}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
