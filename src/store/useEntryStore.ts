import { create } from "zustand";
import type { Entry, EntryInsert, EntryUpdate, VendorSummary, PatientSummary, ProductSummary } from "@/types";
import { entryService } from "@/services";

interface EntryState {
  entries: Entry[];
  loading: boolean;
  error: string | null;
  fetchEntries: () => Promise<void>;
  addEntry: (entry: EntryInsert) => Promise<Entry>;
  updateEntry: (id: string, updates: EntryUpdate) => Promise<Entry>;
  removeEntry: (id: string) => Promise<void>;
  vendorSummaries: () => VendorSummary[];
  patientSummaries: () => PatientSummary[];
  productSummaries: () => ProductSummary[];
  totalCost: () => number;
}

export const useEntryStore = create<EntryState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,

  async fetchEntries() {
    set({ loading: true, error: null });
    try {
      const entries = await entryService.list();
      set({ entries, loading: false });
    } catch (err) {      const message = err instanceof Error ? err.message : "Unknown error";
      set({ error: message, loading: false });
    }
  },

  async addEntry(entry) {
    const created = await entryService.create(entry);
    set((s) => ({ entries: [created, ...s.entries] }));
    return created;
  },

  async updateEntry(id, updates) {
    const updated = await entryService.update(id, updates);
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? updated : e)) }));
    return updated;
  },

  async removeEntry(id) {
    await entryService.remove(id);
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },

  vendorSummaries() {
    const map = new Map<string, VendorSummary>();
    for (const e of get().entries) {
      const existing = map.get(e.vendor);
      if (existing) { existing.entryCount++; existing.totalCost += Number(e.cost) || 0; }
      else { map.set(e.vendor, { name: e.vendor, entryCount: 1, totalCost: Number(e.cost) || 0 }); }
    }    return Array.from(map.values()).sort((a, b) => b.entryCount - a.entryCount);
  },

  patientSummaries() {
    const map = new Map<string, PatientSummary>();
    for (const e of get().entries) {
      if (!e.patient) continue;
      const existing = map.get(e.patient);
      if (existing) { existing.entryCount++; existing.totalCost += Number(e.cost) || 0; }
      else { map.set(e.patient, { name: e.patient, entryCount: 1, totalCost: Number(e.cost) || 0 }); }
    }
    return Array.from(map.values()).sort((a, b) => b.entryCount - a.entryCount);
  },

  productSummaries() {
    const map = new Map<string, ProductSummary>();
    for (const e of get().entries) {
      const key = e.item_number || e.product_name;
      const existing = map.get(key);
      if (existing) {
        existing.entryCount++;
        existing.totalCost += Number(e.cost) || 0;
        if (!existing.vendors.includes(e.vendor)) existing.vendors.push(e.vendor);
      } else {
        map.set(key, { product_name: e.product_name, item_number: e.item_number, entryCount: 1, totalCost: Number(e.cost) || 0, vendors: [e.vendor] });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.entryCount - a.entryCount);
  },
  totalCost() {
    return get().entries.reduce((sum, e) => sum + (Number(e.cost) || 0), 0);
  },
}));