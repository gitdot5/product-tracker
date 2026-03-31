import { useEntryStore } from "@/store/useEntryStore";

export default function Vendors() {
  const loading = useEntryStore((s) => s.loading);
  const vendorSummaries = useEntryStore((s) => s.vendorSummaries);

  const vendors = vendorSummaries();

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
        <h1 className="page-title">Vendors</h1>
        <p className="text-muted">{vendors.length} total</p>
      </header>

      {vendors.length === 0 ? (
        <div className="empty-state">
          <p>No vendors yet</p>
        </div>
      ) : (
        <ul className="card-list">
          {vendors.map((vendor) => (            <li key={vendor.name} className="card">
              <div className="card-row">
                <div className="card-info">
                  <span className="card-name">{vendor.name}</span>
                  <span className="card-meta">
                    {vendor.count} {vendor.count === 1 ? "entry" : "entries"}
                  </span>
                </div>
                <div className="card-right">
                  <span style={{ fontWeight: 600 }}>${vendor.total.toFixed(2)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}