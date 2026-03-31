import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useEntryStore } from "@/store/useEntryStore";
import { ROUTES } from "@/lib/constants";

export default function Products() {
  const entries = useEntryStore((s) => s.entries);
  const loading = useEntryStore((s) => s.loading);
  const productSummaries = useEntryStore((s) => s.productSummaries);
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const products = productSummaries();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.product_name.toLowerCase().includes(q) ||
        p.item_number.toLowerCase().includes(q),
    );
  }, [productSummaries, search, entries]);

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
          <h1 className="page-title">Products</h1>
          <p className="text-muted">
            {filtered.length} {filtered.length === 1 ? "product" : "products"}
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate(ROUTES.ADD)}>
          + Add
        </button>
      </header>

      <div className="search-bar">
        <input
          className="input"
          placeholder="Search name or item number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <p>{search ? "No products match your search" : "No entries yet"}</p>
        </div>
      ) : (        <ul className="card-list">
          {filtered.map((product) => (
            <li key={product.item_number || product.product_name} className="card">
              <div className="card-row">
                <div className="card-info">
                  <span className="card-name">{product.product_name}</span>
                  <span className="card-meta">
                    {product.item_number} · {product.count} {product.count === 1 ? "entry" : "entries"}
                  </span>
                </div>
                <div className="card-right">
                  <span style={{ fontWeight: 600 }}>${product.total.toFixed(2)}</span>
                  <span className="card-meta">{product.vendors.join(", ")}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}