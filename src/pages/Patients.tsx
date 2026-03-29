import { useState, useMemo, useEffect } from "react";
import { useEntryStore } from "@/store";

export default function Patients() {
  const { entries, loading, fetchEntries } = useEntryStore();
  const patientSummaries = useEntryStore((s) => s.patientSummaries);
  const [search, setSearch] = useState("");
  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const patients = patientSummaries();
    if (!q) return patients;
    return patients.filter((p) => p.name.toLowerCase().includes(q));
  }, [patientSummaries, search, entries]);

  if (loading) return <div className="page"><div className="loading-spinner" aria-label="Loading patients" /></div>;
  return (
    <div className="page">
      <header className="page-header"><h1 className="page-title">Patients</h1><p className="text-muted">{filtered.length} total</p></header>
      <div className="search-bar"><input className="input" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search patients" /></div>
      {filtered.length === 0 ? <div className="empty-state"><p>No patients found</p></div> : (
        <ul className="card-list" role="list">
          {filtered.map((patient) => (
            <li key={patient.name} className="card" role="listitem"><div className="card-row">
              <div className="product-thumb" aria-hidden>🏥</div>
              <div className="card-info"><span className="card-name">{patient.name}</span><span className="card-meta">{patient.entryCount} {patient.entryCount === 1 ? "entry" : "entries"}</span></div>
              <div className="card-right"><span style={{ fontWeight: 600 }}>${patient.totalCost.toFixed(2)}</span></div>
            </div></li>))}
        </ul>)}
    </div>
  );
}
