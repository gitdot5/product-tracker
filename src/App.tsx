import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ROUTES } from "@/lib/constants";
import { useSessionStore } from "@/store";
import { useSessionTimeout } from "@/hooks/useSessionTimeout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Dashboard } from "@/components/Dashboard";
import { LockScreen } from "@/components/LockScreen";
import { Toasts } from "@/components/Toasts";

const Products = lazy(() => import("@/pages/Products"));
const AddEntry = lazy(() => import("@/pages/AddEntry"));
const Patients = lazy(() => import("@/pages/Patients"));
const Vendors = lazy(() => import("@/pages/Vendors"));
const Commission = lazy(() => import("@/pages/Commission"));
const Summary = lazy(() => import("@/pages/Summary"));
const AuditLog = lazy(() => import("@/pages/AuditLog"));
const MiMedx = lazy(() => import("@/pages/MiMedx"));
const PriceSheets = lazy(() => import("@/pages/PriceSheets"));

function PageLoader() {
  return <div className="page"><div className="loading-spinner" aria-label="Loading page" /></div>;
}

function AppShell() {
  const locked = useSessionStore((s) => s.locked);
  useSessionTimeout();
  if (locked) return <LockScreen />;
  return (
    <Dashboard>      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path={ROUTES.PRODUCTS} element={<Products />} />
          <Route path={ROUTES.ADD} element={<AddEntry />} />
          <Route path={ROUTES.PATIENTS} element={<Patients />} />
          <Route path={ROUTES.VENDORS} element={<Vendors />} />
          <Route path={ROUTES.COMMISSION} element={<Commission />} />
          <Route path={ROUTES.SUMMARY} element={<Summary />} />
          <Route path={ROUTES.AUDIT} element={<AuditLog />} />
          <Route path={ROUTES.MIMEDX} element={<MiMedx />} />
          <Route path={ROUTES.PRICES} element={<PriceSheets />} />
          <Route path="*" element={<Navigate to={ROUTES.PRODUCTS} replace />} />
        </Routes>
      </Suspense>
    </Dashboard>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppShell />
        <Toasts />
      </BrowserRouter>
    </ErrorBoundary>
  );
}