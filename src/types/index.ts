export interface Entry {
  id: string;
  created_at: string;
  system_id: string;
  facility: string;
  vendor: string;
  date: string;
  product_name: string;
  item_number: string;
  cost: number;
  patient: string;
}

export type EntryInsert = Omit<Entry, "id" | "created_at">;
export type EntryUpdate = Partial<Omit<Entry, "id" | "created_at">>;

export interface VendorSummary {
  name: string;
  entryCount: number;
  totalCost: number;
}

export interface PatientSummary {
  name: string;
  entryCount: number;
  totalCost: number;
}

export interface ProductSummary {
  product_name: string;
  item_number: string;  entryCount: number;
  totalCost: number;
  vendors: string[];
}

export interface Toast {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}