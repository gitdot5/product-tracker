import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface SessionState {
  locked: boolean;
  pin: string;
  lock: () => void;
  unlock: (attempt: string) => boolean;
}

const DEFAULT_PIN = import.meta.env.VITE_APP_PIN ?? "1234";

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      locked: true,
      pin: DEFAULT_PIN,

      lock() {
        set({ locked: true });
      },

      unlock(attempt) {
        if (attempt !== get().pin) return false;
        set({ locked: false });
        return true;
      },
    }),
    {
      name: "pt-session",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ locked: s.locked }),
    },
  ),
);
