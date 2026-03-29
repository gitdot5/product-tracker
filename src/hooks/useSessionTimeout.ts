import { useEffect, useRef, useCallback } from "react";
import { useSessionStore } from "@/store";
import { SESSION_TIMEOUT_MS, SESSION_CHECK_INTERVAL_MS } from "@/lib/constants";

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;

export function useSessionTimeout(): void {
  const locked = useSessionStore((s) => s.locked);
  const lock = useSessionStore((s) => s.lock);
  const lastActivity = useRef(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const resetTimer = useCallback(() => { lastActivity.current = Date.now(); }, []);

  useEffect(() => {
    if (locked) return;
    ACTIVITY_EVENTS.forEach((event) => {
      window.addEventListener(event, resetTimer, { passive: true });
    });
    intervalRef.current = setInterval(() => {
      if (Date.now() - lastActivity.current >= SESSION_TIMEOUT_MS) lock();
    }, SESSION_CHECK_INTERVAL_MS);
    return () => {
      ACTIVITY_EVENTS.forEach((event) => { window.removeEventListener(event, resetTimer); });
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [locked, lock, resetTimer]);
}