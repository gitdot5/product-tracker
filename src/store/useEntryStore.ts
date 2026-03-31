import { create } from "zustand";
import type { Entry, EntryInsert, GroupSummary, ProductSummary } from "@/types";
import { api } from "@/services/api";

interface EntryState {
  entries: Entry[];
  loading: boolean;
  error: string | null;

  fetch: () => Promise<void>;
  add: (entry: EntryInsert) => Promise<Entry>;
  remove: (id: string) => Promise<void>;

  vendorSummaries: () => GroupSummary[];
  patientSummaries: () => GroupSummary[];
  productSummaries: () => ProductSummary[];
  totalCost: () => number;
}

function groupBy(entries: Entry[], key: "vendor" | "patient"): GroupSummary[] {
  const map = new Map<string, GroupSummary>();

  for (const e of entries) {
    const name = e[key];
    if (!name) continue;

    const existing = map.get(name);
    const cost = Number(e.cost) || 0;

    if (existing) {
      existing.count++;
      existing.total += cost;
    } else {
      map.set(name, { name, count: 1, total: cost });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

export const useEntryStore = create<EntryState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,

  async fetch() {
    set({ loading: true, error: null });
    try {
      const entries = await api.list();
      set({ entries, loading: false });
    } catch (err: any) {
      set({ error: err.message ?? "Unknown error", loading: false });
    }
  },

  async add(entry) {
    const created = await api.create(entry);
    set((s) => ({ entries: [created, ...s.entries] }));
    return created;
  },

  async remove(id) {
    await api.remove(id);
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },

  vendorSummaries: () => groupBy(get().entries, "vendor"),
  patientSummaries: () => groupBy(get().entries, "patient"),

  productSummaries() {
    const map = new Map<string, ProductSummary>();

    for (const e of get().entries) {
      const key = e.item_number || e.product_name;
      const cost = Number(e.cost) || 0;
      const existing = map.get(key);

      if (existing) {
        existing.count++;
        existing.total += cost;
        if (!existing.vendors.includes(e.vendor)) existing.vendors.push(e.vendor);
      } else {
        map.set(key, {
          product_name: e.product_name,
          item_number: e.item_number,
          count: 1,
          total: cost,
          vendors: [e.vendor],
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  },

  totalCost: () => get().entries.reduce((sum, e) => sum + (Number(e.cost) || 0), 0),
}));
