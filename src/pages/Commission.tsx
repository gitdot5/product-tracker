import { useEffect } from "react";
import { useEntryStore } from "@/store";

export default function Commission() {
  const { entries, loading, fetchEntries, totalCost } = useEntryStore();
  useEffect(() => { fetchEntries(); }, [fetchEntries]);
  if (loading) return <div className="page"><div className="loading-spinner" aria-label="Loading commissions" /></div>;
  return (
    <div className="page">
      <header className="page-header"><div><h1 className="page-title">Commissions</h1><p className="text-muted">{entries.length} entries</p></div></header>
      <div className="stat-card" style={{ marginBottom: 20 }}>
        <p className="stat-label">Total Cost</p>
        <p className="stat-value" style={{ color: "var(--success)" }}>${totalCost().toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
      </div>
      {entries.length === 0 ? <div className="empty-state"><p>No commission entries yet</p></div> : (
        <ul className="card-list" role="list">
          {entries.map((entry) => (
            <li key={entry.id} className="card" role="listitem"><div className="card-row">
              <div className="product-thumb" aria-hidden>💰</div>
              <div className="card-info"><span className="card-name">{entry.product_name}</span>
                <span className="card-meta">{entry.vendor} · {entry.facility} · {new Date(entry.date).toLocaleDateString()}</span></div>
              <div className="card-right"><span className="stock-pill stock-ok">${Number(entry.cost).toFixed(2)}</span></div>
            </div></li>))}
        </ul>)}
    </div>
  );
}