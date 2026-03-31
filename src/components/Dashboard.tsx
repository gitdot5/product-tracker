import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { ROUTES } from "@/lib/constants";

const NAV_ITEMS = [
  { to: ROUTES.PRODUCTS, label: "Products" },
  { to: ROUTES.PATIENTS, label: "Patients" },
  { to: ROUTES.ADD, label: "Add" },
  { to: ROUTES.COMMISSION, label: "Commission" },
  { to: ROUTES.SUMMARY, label: "Summary" },
];

export function Dashboard({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <main className="page-container">{children}</main>

      <nav className="bottom-nav">
        {NAV_ITEMS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}