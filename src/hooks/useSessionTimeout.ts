import { useEffect, useRef, useCallback } from "react";
import { useSessionStore } from "@/store/useSessionStore";
import { SESSION_TIMEOUT_MS } from "@/lib/constants";

const EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;
const CHECK_INTERVAL = 10_000;

export function useSessionTimeout() {
  const locked = useSessionStore((s) => s.locked);
  const lock = useSessionStore((s) => s.lock);
  const lastActivity = useRef(Date.now());

  const resetTimer = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);

  useEffect(() => {
    if (locked) return;

    for (const event of EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    const interval = setInterval(() => {
      if (Date.now() - lastActivity.current >= SESSION_TIMEOUT_MS) {
        lock();
      }
    }, CHECK_INTERVAL);

    return () => {
      for (const event of EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
      clearInterval(interval);
    };
  }, [locked, lock, resetTimer]);
}
