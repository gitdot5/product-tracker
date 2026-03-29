import { useEffect } from "react";
import { useEntryStore } from "@/store";

export default function Summary() {
  const { entries, loading, fetchEntries, totalCost, vendorSummaries, patientSummaries, productSummaries } = useEntryStore();
  useEffect(() => { fetchEntries(); }, [fetchEntries]);
  if (loading) return <div className="page"><div className="loading-spinner" aria-label="Loading summary" /></div>;
  const vendors = vendorSummaries(); const patients = patientSummaries(); const products = productSummaries(); const cost = totalCost();
  return (
    <div className="page">
      <header className="page-header"><h1 className="page-title">Summary</h1></header>
      <div className="stats-grid">
        <div className="stat-card"><p className="stat-label">Total Entries</p><p className="stat-value">{entries.length}</p></div>
        <div className="stat-card"><p className="stat-label">Total Cost</p><p className="stat-value" style={{ color: "var(--success)" }}>${cost.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p></div>
        <div className="stat-card"><p className="stat-label">Products</p><p className="stat-value">{products.length}</p></div>
        <div className="stat-card"><p className="stat-label">Patients</p><p className="stat-value">{patients.length}</p></div>
      </div>
      {vendors.length > 0 && (<section><h2 className="section-title">Vendors ({vendors.length})</h2>
        <ul className="card-list" role="list">{vendors.slice(0, 5).map((v) => (
          <li key={v.name} className="card card-compact" role="listitem"><div className="card-row">
            <div className="card-info"><span className="card-name">{v.name}</span><span className="card-meta">{v.entryCount} entries</span></div>
            <div className="card-right"><span style={{ fontWeight: 600 }}>${v.totalCost.toFixed(2)}</span></div>
          </div></li>))}</ul></section>)}
      {entries.length > 0 && (<section><h2 className="section-title">Recent Entries</h2>
        <ul className="card-list" role="list">{entries.slice(0, 5).map((e) => (
          <li key={e.id} className="card card-compact" role="listitem"><div className="card-row">
            <div className="card-info"><span className="card-name">{e.product_name}</span>
              <span className="card-meta">{e.vendor} · {e.patient || "No patient"} · {new Date(e.date).toLocaleDateString()}</span></div>
            <div className="card-right"><span style={{ fontWeight: 600 }}>${Number(e.cost).toFixed(2)}</span></div>          </div></li>))}</ul></section>)}
    </div>
  );
}