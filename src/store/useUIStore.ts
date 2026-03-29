import { create } from "zustand";
import type { Toast } from "@/types";

interface UIState {
  toasts: Toast[];
  globalLoading: boolean;
  showToast: (type: Toast["type"], message: string) => void;
  dismissToast: (id: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  toasts: [],
  globalLoading: false,
  showToast(type, message) {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3000);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  setLoading(loading) { set({ globalLoading: loading }); },
}));