import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useEntryStore } from "@/store";
import { ROUTES } from "@/lib/constants";

export default function Products() {
  const { entries, loading, fetchEntries } = useEntryStore();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const productSummaries = useEntryStore((s) => s.productSummaries);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const products = productSummaries();
    if (!q) return products;
    return products.filter((p) => p.product_name.toLowerCase().includes(q) || p.item_number.toLowerCase().includes(q));
  }, [productSummaries, search, entries]);

  if (loading) return <div className="page"><div className="loading-spinner" aria-label="Loading products" /></div>;

  return (
    <div className="page">
      <header className="page-header">
        <div><h1 className="page-title">Products</h1><p className="text-muted">{filtered.length} products</p></div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate(ROUTES.ADD)} aria-label="Add new entry">+ Add</button>
      </header>
      <div className="search-bar">        <input className="input" placeholder="Search name or item number…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search products" />
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state"><p>{search ? "No products match your search" : "No entries yet"}</p></div>
      ) : (
        <ul className="card-list" role="list">
          {filtered.map((product) => (
            <li key={product.item_number || product.product_name} className="card" role="listitem">
              <div className="card-row">
                <div className="product-thumb" aria-hidden>📦</div>
                <div className="card-info">
                  <span className="card-name">{product.product_name}</span>
                  <span className="card-meta">{product.item_number} · {product.entryCount} {product.entryCount === 1 ? "entry" : "entries"}</span>
                </div>
                <div className="card-right">
                  <span style={{ fontWeight: 600 }}>${product.totalCost.toFixed(2)}</span>
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