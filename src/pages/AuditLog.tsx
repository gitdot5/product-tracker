import { useEntryStore } from "@/store/useEntryStore";

export default function AuditLog() {
  const entries = useEntryStore((s) => s.entries);
  const loading = useEntryStore((s) => s.loading);

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
        <h1 className="page-title">Audit Log</h1>
        <p className="text-muted">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </p>
      </header>

      {entries.length === 0 ? (
        <div className="empty-state">
          <p>No entries yet</p>
        </div>
      ) : (
        <ul className="card-list">
          {entries.map((entry) => (            <li key={entry.id} className="card card-compact">
              <div className="card-row">
                <div className="card-info">
                  <span className="card-name">
                    {entry.product_name} — {entry.item_number}
                  </span>
                  <span className="card-meta">
                    {entry.vendor} · {entry.facility} · {entry.patient || "—"}
                  </span>
                </div>
                <div className="card-right">
                  <span style={{ fontWeight: 600 }}>${Number(entry.cost).toFixed(2)}</span>
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    {new Date(entry.date).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}