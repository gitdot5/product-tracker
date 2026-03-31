import { useEntryStore } from "@/store/useEntryStore";

export default function Commission() {
  const entries = useEntryStore((s) => s.entries);
  const loading = useEntryStore((s) => s.loading);
  const totalCost = useEntryStore((s) => s.totalCost);

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
        <div>
          <h1 className="page-title">Commissions</h1>
          <p className="text-muted">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </p>
        </div>
      </header>

      <div className="stat-card" style={{ marginBottom: 20 }}>
        <p className="stat-label">Total Cost</p>
        <p className="stat-value" style={{ color: "var(--success)" }}>          ${totalCost().toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </p>
      </div>

      {entries.length === 0 ? (
        <div className="empty-state">
          <p>No commission entries yet</p>
        </div>
      ) : (
        <ul className="card-list">
          {entries.map((entry) => (
            <li key={entry.id} className="card">
              <div className="card-row">
                <div className="card-info">
                  <span className="card-name">{entry.product_name}</span>
                  <span className="card-meta">
                    {entry.vendor} · {entry.facility} · {new Date(entry.date).toLocaleDateString()}
                  </span>
                </div>
                <div className="card-right">
                  <span className="stock-pill stock-ok">${Number(entry.cost).toFixed(2)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}