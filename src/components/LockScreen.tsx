import { useState, useCallback, type FormEvent } from "react";
import { useSessionStore } from "@/store";

export function LockScreen() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const unlock = useSessionStore((s) => s.unlock);

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    const success = unlock(pin);
    if (success) { setError(false); }
    else { setError(true); setPin(""); }
  }, [pin, unlock]);

  return (
    <div className="lock-screen">
      <div className="lock-content">
        <div className="lock-icon" aria-hidden>🔒</div>
        <h1>Product Tracker</h1>
        <p className="text-muted">Enter PIN to continue</p>
        <form onSubmit={handleSubmit} className="lock-form">
          <input type="password" inputMode="numeric" maxLength={6}
            className={`input pin-input ${error ? "input-error" : ""}`}
            value={pin} onChange={(e) => setPin(e.target.value)}
            placeholder="••••" autoFocus aria-label="PIN code" />
          {error && <p className="text-error">Incorrect PIN</p>}
          <button type="submit" className="btn btn-primary btn-block">Unlock</button>
        </form>      </div>
    </div>
  );
}