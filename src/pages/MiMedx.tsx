import { useState, useMemo, useEffect } from "react";
import { useEntryStore } from "@/store";

export default function MiMedx() {
  const { entries, loading, fetchEntries } = useEntryStore();
  const [search, setSearch] = useState("");
  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const mimedxEntries = useMemo(() => {
    const q = search.toLowerCase();
    return entries.filter((e) => e.vendor.toLowerCase().includes("mimedx"))
      .filter((e) => !q || e.product_name.toLowerCase().includes(q) || e.item_number.toLowerCase().includes(q));
  }, [entries, search]);

  if (loading) return <div className="page"><div className="loading-spinner" aria-label="Loading MiMedx entries" /></div>;
  return (
    <div className="page">
      <header className="page-header"><h1 className="page-title">MiMedx</h1><p className="text-muted">{mimedxEntries.length} entries</p></header>
      <div className="search-bar"><input className="input" placeholder="Search MiMedx products…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search MiMedx entries" /></div>
      {mimedxEntries.length === 0 ? <div className="empty-state"><p>No MiMedx entries found</p></div> : (
        <ul className="card-list" role="list">
          {mimedxEntries.map((e) => (
            <li key={e.id} className="card" role="listitem"><div className="card-row">
              <div className="product-thumb" aria-hidden>🧬</div>
              <div className="card-info"><span className="card-name">{e.product_name}</span>
                <span className="card-meta">{e.item_number} · {e.facility} · {new Date(e.date).toLocaleDateString()}</span></div>
              <div className="card-right"><span style={{ fontWeight: 600 }}>${Number(e.cost).toFixed(2)}</span></div>
            </div></li>))}
        </ul>)}
    </div>
  );
}
