import { supabase } from "@/lib/supabase";
import type { Entry, EntryInsert } from "@/types";

const TABLE = "entries";

async function list(): Promise<Entry[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("date", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

async function create(entry: EntryInsert): Promise<Entry> {
  const { data, error } = await supabase
    .from(TABLE)
    .insert(entry)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function remove(id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}

export const api = { list, create, remove };
