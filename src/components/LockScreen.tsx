import { useState, type FormEvent } from "react";
import { useSessionStore } from "@/store/useSessionStore";

export function LockScreen() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const unlock = useSessionStore((s) => s.unlock);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (unlock(pin)) {
      setError(false);
    } else {
      setError(true);
      setPin("");
    }
  }

  return (
    <div className="lock-screen">
      <div className="lock-content">
        <h1>Product Tracker</h1>
        <p className="text-muted">Enter PIN to continue</p>

        <form onSubmit={handleSubmit} className="lock-form">
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            className={`input pin-input ${error ? "input-error" : ""}`}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            autoFocus
          />
          {error && <p className="text-error">Incorrect PIN</p>}
          <button type="submit" className="btn btn-primary btn-block">
            Unlock
          </button>
        </form>
      </div>
    </div>
  );
}