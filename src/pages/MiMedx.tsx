import { useState, useMemo } from "react";
import { useEntryStore } from "@/store/useEntryStore";

export default function MiMedx() {
  const entries = useEntryStore((s) => s.entries);
  const loading = useEntryStore((s) => s.loading);
  const [search, setSearch] = useState("");

  const mimedxEntries = useMemo(() => {
    const q = search.toLowerCase();
    return entries
      .filter((e) => e.vendor.toLowerCase().includes("mimedx"))
      .filter(
        (e) =>
          !q ||
          e.product_name.toLowerCase().includes(q) ||
          e.item_number.toLowerCase().includes(q),
      );
  }, [entries, search]);

  if (loading) {
    return (
      <div className="page">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">        <h1 className="page-title">MiMedx</h1>
        <p className="text-muted">
          {mimedxEntries.length} {mimedxEntries.length === 1 ? "entry" : "entries"}
        </p>
      </header>

      <div className="search-bar">
        <input
          className="input"
          placeholder="Search MiMedx products…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {mimedxEntries.length === 0 ? (
        <div className="empty-state">
          <p>No MiMedx entries found</p>
        </div>
      ) : (
        <ul className="card-list">
          {mimedxEntries.map((e) => (
            <li key={e.id} className="card">
              <div className="card-row">
                <div className="card-info">
                  <span className="card-name">{e.product_name}</span>
                  <span className="card-meta">
                    {e.item_number} · {e.facility} · {new Date(e.date).toLocaleDateString()}
                  </span>                </div>
                <div className="card-right">
                  <span style={{ fontWeight: 600 }}>${Number(e.cost).toFixed(2)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}