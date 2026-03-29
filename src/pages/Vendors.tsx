import { useEffect } from "react";
import { useEntryStore } from "@/store";

export default function Vendors() {
  const { loading, fetchEntries } = useEntryStore();
  const vendorSummaries = useEntryStore((s) => s.vendorSummaries);
  useEffect(() => { fetchEntries(); }, [fetchEntries]);
  const vendors = vendorSummaries();
  if (loading) return <div className="page"><div className="loading-spinner" aria-label="Loading vendors" /></div>;
  return (
    <div className="page">
      <header className="page-header"><h1 className="page-title">Vendors</h1><p className="text-muted">{vendors.length} total</p></header>
      {vendors.length === 0 ? <div className="empty-state"><p>No vendors yet</p></div> : (
        <ul className="card-list" role="list">
          {vendors.map((vendor) => (
            <li key={vendor.name} className="card" role="listitem"><div className="card-row">
              <div className="product-thumb" aria-hidden>🏢</div>
              <div className="card-info"><span className="card-name">{vendor.name}</span><span className="card-meta">{vendor.entryCount} {vendor.entryCount === 1 ? "entry" : "entries"}</span></div>
              <div className="card-right"><span style={{ fontWeight: 600 }}>${vendor.totalCost.toFixed(2)}</span></div>
            </div></li>))}
        </ul>)}
    </div>
  );
}