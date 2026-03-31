import { useEntryStore } from "@/store/useEntryStore";

export default function PriceSheets() {
  const loading = useEntryStore((s) => s.loading);
  const productSummaries = useEntryStore((s) => s.productSummaries);

  const products = productSummaries();

  if (loading) {
    return (
      <div className="page">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Price Sheets</h1>
        <p className="text-muted">
          {products.length} {products.length === 1 ? "product" : "products"}
        </p>
      </header>

      {products.length === 0 ? (
        <div className="empty-state">
          <p>No pricing data yet</p>
        </div>
      ) : (        <ul className="card-list">
          {products.map((p) => {
            const avg = p.count > 0 ? p.total / p.count : 0;
            return (
              <li key={p.item_number || p.product_name} className="card">
                <div className="card-row">
                  <div className="card-info">
                    <span className="card-name">{p.product_name}</span>
                    <span className="card-meta">
                      {p.item_number} · {p.vendors.join(", ")} · {p.count} {p.count === 1 ? "use" : "uses"}
                    </span>
                  </div>
                  <div className="card-right">
                    <span style={{ fontWeight: 600 }}>${p.total.toFixed(2)}</span>
                    <span className="text-muted" style={{ fontSize: 12 }}>avg ${avg.toFixed(2)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}