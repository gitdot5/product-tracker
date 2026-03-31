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

export interface GroupSummary {
  name: string;
  count: number;
  total: number;
}

export interface ProductSummary {
  product_name: string;
  item_number: string;
  count: number;
  total: number;
  vendors: string[];
}

export interface Toast {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}
