import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface SessionState {
  locked: boolean;
  pin: string;
  lock: () => void;
  unlock: (attempt: string) => boolean;
  setPin: (newPin: string) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      locked: true,
      pin: import.meta.env.VITE_APP_PIN ?? "1234",
      lock() { set({ locked: true }); },
      unlock(attempt: string) {
        if (attempt === get().pin) {
          set({ locked: false });
          return true;
        }
        return false;
      },
      setPin(newPin: string) { set({ pin: newPin }); },
    }),
    {
      name: "pt-session",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ locked: state.locked }),
    },
  ),
);