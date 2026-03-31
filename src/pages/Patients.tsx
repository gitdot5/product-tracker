import { useState, useMemo } from "react";
import { useEntryStore } from "@/store/useEntryStore";

export default function Patients() {
  const entries = useEntryStore((s) => s.entries);
  const loading = useEntryStore((s) => s.loading);
  const patientSummaries = useEntryStore((s) => s.patientSummaries);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const patients = patientSummaries();
    if (!q) return patients;
    return patients.filter((p) => p.name.toLowerCase().includes(q));
  }, [patientSummaries, search, entries]);

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
        <h1 className="page-title">Patients</h1>
        <p className="text-muted">{filtered.length} total</p>
      </header>
      <div className="search-bar">
        <input
          className="input"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <p>No patients found</p>
        </div>
      ) : (
        <ul className="card-list">
          {filtered.map((patient) => (
            <li key={patient.name} className="card">
              <div className="card-row">
                <div className="card-info">
                  <span className="card-name">{patient.name}</span>
                  <span className="card-meta">
                    {patient.count} {patient.count === 1 ? "entry" : "entries"}
                  </span>
                </div>
                <div className="card-right">
                  <span style={{ fontWeight: 600 }}>${patient.total.toFixed(2)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}