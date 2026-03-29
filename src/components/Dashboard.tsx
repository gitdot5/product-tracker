import { type ReactNode, useCallback } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ROUTES } from "@/lib/constants";

interface NavItem { to: string; label: string; icon: string; }

const NAV_ITEMS: NavItem[] = [
  { to: ROUTES.PRODUCTS, label: "Products", icon: "📦" },
  { to: ROUTES.PATIENTS, label: "Patients", icon: "🏥" },
  { to: ROUTES.ADD, label: "Add", icon: "➕" },
  { to: ROUTES.COMMISSION, label: "Commission", icon: "💰" },
  { to: ROUTES.SUMMARY, label: "Summary", icon: "📊" },
];

export function Dashboard({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isActive = useCallback((path: string) => location.pathname === path, [location.pathname]);

  return (
    <div className="app-shell">
      <main className="page-container">{children}</main>
      <nav className="bottom-nav" aria-label="Main navigation">
        {NAV_ITEMS.map(({ to, label, icon }) => (
          <NavLink key={to} to={to}
            className={`nav-item ${isActive(to) ? "active" : ""}`}
            aria-current={isActive(to) ? "page" : undefined}>
            <span className="nav-icon" aria-hidden>{icon}</span>
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>  );
}