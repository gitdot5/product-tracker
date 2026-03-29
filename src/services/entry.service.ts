import { supabase } from "@/lib/supabase";
import type { Entry, EntryInsert, EntryUpdate } from "@/types";

const TABLE = "entries";

export const entryService = {
  async list(): Promise<Entry[]> {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .order("date", { ascending: false });
    if (error) throw new Error(`Failed to fetch entries: ${error.message}`);
    return data ?? [];
  },

  async getById(id: string): Promise<Entry | null> {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .eq("id", id)
      .single();
    if (error) throw new Error(`Failed to fetch entry: ${error.message}`);
    return data;
  },

  async create(entry: EntryInsert): Promise<Entry> {
    const { data, error } = await supabase
      .from(TABLE)
      .insert(entry)      .select()
      .single();
    if (error) throw new Error(`Failed to create entry: ${error.message}`);
    return data;
  },

  async update(id: string, updates: EntryUpdate): Promise<Entry> {
    const { data, error } = await supabase
      .from(TABLE)
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`Failed to update entry: ${error.message}`);
    return data;
  },

  async remove(id: string): Promise<void> {
    const { error } = await supabase.from(TABLE).delete().eq("id", id);
    if (error) throw new Error(`Failed to delete entry: ${error.message}`);
  },

  async search(query: string): Promise<Entry[]> {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .or(
        `product_name.ilike.%${query}%,item_number.ilike.%${query}%,patient.ilike.%${query}%,vendor.ilike.%${query}%`,
      )
      .order("date", { ascending: false });    if (error) throw new Error(`Search failed: ${error.message}`);
    return data ?? [];
  },
};