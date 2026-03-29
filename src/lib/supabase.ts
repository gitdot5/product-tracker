import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  console.error(
    "[supabase] Missing env vars. Copy .env.example → .env and fill in your credentials.",
  );
}

export const supabase: SupabaseClient = createClient(url ?? "", key ?? "");