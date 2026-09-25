import { Bot, Boxes, DatabaseZap, LayoutDashboard, LogOut, Menu, Moon, Settings, ShieldCheck, Sun, SunMoon, Workflow } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { BRAND } from "@nexus/shared/brand";
import { post } from "../lib/api";
import { applyTheme, loadTheme, type ThemeChoice } from "../lib/theme";
import type { Me } from "../App";
import { NotificationBell } from "./NotificationBell";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/apps", label: "Applications", icon: Boxes },
  { to: "/databases", label: "Databases", icon: DatabaseZap },
  { to: "/pipelines", label: "Pipelines", icon: Workflow, permission: "pipelines.view" },
  { to: "/backups", label: "Backups", icon: ShieldCheck },
  { to: "/ai", label: BRAND.assistantName, icon: Bot },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme());
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const next: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon;

  return (
    <div className="shell">
      <div className="topbar-mobile">
        <button className="btn ghost" aria-label="Menu" onClick={() => setOpen(!open)}>
          <Menu size={18} />
        </button>
        <strong>{BRAND.productName}</strong>
        <NotificationBell />
      </div>
      <nav className={`sidebar ${open ? "open" : ""}`} aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 32 32">
              <path d="M9 22V10l14 12V10" stroke="currentColor" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          {BRAND.productName}
          <span className="spacer" />
          <span className="bell-desktop"><NotificationBell /></span>
        </div>
        {NAV.filter((n) => !n.permission || me.permissions.includes(n.permission)).map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            <Icon size={18} aria-hidden /> {label}
          </NavLink>
        ))}
        <div className="sidebar-footer">
          <button
            className="nav-link btn ghost"
            style={{ justifyContent: "flex-start" }}
            onClick={() => {
              const t = next[theme];
              setTheme(t);
              applyTheme(t);
            }}
          >
            <ThemeIcon size={18} aria-hidden /> {theme === "system" ? "Automatic theme" : theme === "light" ? "Light theme" : "Dark theme"}
          </button>
          <div className="small muted" style={{ padding: "8px 10px" }}>
            Signed in as {me.user.displayName}
            {me.remote ? " (remote)" : ""}
          </div>
          {me.remote && (
            <button className="nav-link btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => post("/auth/logout").then(() => location.reload())}>
              <LogOut size={18} aria-hidden /> Sign out
            </button>
          )}
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
