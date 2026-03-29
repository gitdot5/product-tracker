import { useEffect } from "react";
import { useEntryStore } from "@/store";

export default function PriceSheets() {
  const { loading, fetchEntries, productSummaries } = useEntryStore();
  useEffect(() => { fetchEntries(); }, [fetchEntries]);
  const products = productSummaries();

  if (loading) return <div className="page"><div className="loading-spinner" aria-label="Loading price sheets" /></div>;
  return (
    <div className="page">
      <header className="page-header"><h1 className="page-title">Price Sheets</h1><p className="text-muted">{products.length} products</p></header>
      {products.length === 0 ? <div className="empty-state"><p>No pricing data yet</p></div> : (
        <ul className="card-list" role="list">
          {products.map((p) => {
            const avgCost = p.entryCount > 0 ? p.totalCost / p.entryCount : 0;
            return (
              <li key={p.item_number || p.product_name} className="card" role="listitem">
                <div className="card-row">
                  <div className="card-info">
                    <span className="card-name">{p.product_name}</span>
                    <span className="card-meta">{p.item_number} · {p.vendors.join(", ")} · {p.entryCount} uses</span>
                  </div>
                  <div className="card-right">
                    <span style={{ fontWeight: 600 }}>${p.totalCost.toFixed(2)}</span>
                    <span className="text-muted" style={{ fontSize: 12 }}>avg ${avgCost.toFixed(2)}</span>
                  </div>
                </div>
              </li>);
          })}
        </ul>)}
    </div>
  );
}
