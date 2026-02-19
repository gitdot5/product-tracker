import { useState, useRef, useEffect, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════
// HIPAA COMPLIANCE LAYER
// ═══════════════════════════════════════════════════════════════

// 1. ENCRYPTION — AES-GCM via Web Crypto API
const ENCRYPTION_KEY_NAME = "pt-enc-key";

async function getOrCreateKey() {
    const stored = sessionStorage.getItem(ENCRYPTION_KEY_NAME);
    if (stored) {
        const raw = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
        return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
    }
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const exported = await crypto.subtle.exportKey("raw", key);
    sessionStorage.setItem(ENCRYPTION_KEY_NAME, btoa(String.fromCharCode(...new Uint8Array(exported))));
    return key;
}

async function encryptData(data) {
    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return JSON.stringify({ iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...new Uint8Array(encrypted))) });
}

async function decryptData(ciphertext) {
    try {
        const key = await getOrCreateKey();
        const { iv, data } = JSON.parse(ciphertext);
        const ivArr = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
        const dataArr = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivArr }, key, dataArr);
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

// 2. SECURE STORAGE — Encrypted localStorage wrapper
const secureStorage = {
    get: async (k) => {
        const raw = localStorage.getItem(k);
        if (!raw) return null;
        // Try decrypting first; if that fails, it's unencrypted legacy data
        const decrypted = await decryptData(raw);
        if (decrypted !== null) return decrypted;
        // Migrate unencrypted data
        try {
            const parsed = JSON.parse(raw);
            await secureStorage.set(k, parsed); // Re-save encrypted
            return parsed;
        } catch { return null; }
    },
    set: async (k, v) => {
        const encrypted = await encryptData(v);
        localStorage.setItem(k, encrypted);
        return true;
    },
    remove: (k) => localStorage.removeItem(k)
};

// 3. AUDIT LOG
async function auditLog(action, details = {}) {
    const logs = (await secureStorage.get("pt-audit-log")) || [];
    logs.push({
        timestamp: new Date().toISOString(),
        action,
        ...details
    });
    // Keep last 500 entries
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await secureStorage.set("pt-audit-log", logs);
}

// ═══════════════════════════════════════════════════════════════
// APP CONFIG (NO PHI IN SOURCE CODE)
// ═══════════════════════════════════════════════════════════════

const VENDORS = ["4Web", "Altus", "Amplify", "BoneStim", "Carlsmed", "Cellerate", "Choice", "Curiteva", "Exsurco", "ISTO", "MiMedx", "Providence", "Royal", "Spinewave", "Stimulan", "Xtant"];
const SYSTEMS = {
    test: { label: "Test", prefix: "test", facilities: ["Northside", "NEGA"], color: "#f80" },
    kancherla: { label: "Kancherla", prefix: "kancherla", facilities: ["Northside"], color: "#f0a" },
    burch: { label: "Burch", prefix: "burch", facilities: ["Northside", "NEGA"], color: "#0af" }
};

// Demo seed — NO real patient names, NO real item numbers
const SEED = [
    { id: 1, vendor: "MiMedx", facility: "Northside", date: "2026-02-06", productName: "EpiFix", itemNumber: "DEMO-001", cost: 1500, patient: "Demo Patient A" },
    { id: 2, vendor: "MiMedx", facility: "Northside", date: "2026-02-06", productName: "EpiFix", itemNumber: "DEMO-002", cost: 1500, patient: "Demo Patient B" },
    { id: 3, vendor: "MiMedx", facility: "NEGA", date: "2026-02-11", productName: "AmnioEffect", itemNumber: "DEMO-003", cost: 3200, patient: "Demo Patient C" },
    { id: 4, vendor: "MiMedx", facility: "NEGA", date: "2026-02-11", productName: "AxioFill", itemNumber: "DEMO-004", cost: 2845, patient: "Demo Patient D" }
];

const fmt = (n) => "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// SESSION TIMEOUT CONFIG
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes of inactivity

// Icons (SVG)
const Icons = {
    Products: <path d="M21 16.5C21 16.88 20.79 17.21 20.47 17.38L12.57 21.82C12.41 21.94 12.21 22 12 22C11.79 22 11.59 21.94 11.43 21.82L3.53 17.38C3.21 17.21 3 16.88 3 16.5V7.5C3 7.12 3.21 6.79 3.53 6.62L11.43 2.18C11.59 2.06 11.79 2 12 2C12.21 2 12.41 2.06 12.57 2.18L20.47 6.62C20.79 6.79 21 7.12 21 7.5V16.5ZM12 4.15L6.04 7.5L12 10.85L17.96 7.5L12 4.15ZM5 8.66V15.34L11 18.71V12.03L5 8.66ZM13 18.71L19 15.34V8.66L13 12.03V18.71Z" fill="currentColor" />,
    Add: <path d="M19 13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor" />,
    Patients: <path d="M12 4A4 4 0 0 1 16 8A4 4 0 0 1 12 12A4 4 0 0 1 8 8A4 4 0 0 1 12 4ZM12 14C16.42 14 20 15.79 20 18V20H4V18C4 15.79 7.58 14 12 14Z" fill="currentColor" />,
    MiMedx: <path d="M3 17.25V21H6.75L17.81 9.94L14.06 6.19L3 17.25ZM20.71 7.04C21.1 6.65 21.1 6.02 20.71 5.63L18.37 3.29C17.98 2.9 17.35 2.9 16.96 3.29L15.13 5.12L18.88 8.87L20.71 7.04Z" fill="currentColor" />,
    Commission: <path d="M11.8 10.9C9.53 10.31 8.8 9.7 8.8 8.75C8.8 7.66 10.04 6.9 11.56 6.91C12.87 6.92 13.58 7.35 13.84 7.61L15 6C14.47 5.4 13.5 4.97 12.28 4.79V3H10.74V4.74C9.17 5 7 5.8 7 8.74C7 11.66 9.68 12.38 11.96 13C14.06 13.55 14.86 14.26 14.86 15.33C14.86 16.3 13.9 17.15 12.08 17.15C10.46 17.15 9.4 16.32 8.94 15.82L7.69 17.4C8.25 18.3 9.46 19 11.08 19.16V21H12.61V19.18C14.45 18.9 16.7 17.93 16.7 15.34C16.7 12.37 13.93 11.45 11.8 10.9Z" fill="currentColor" />,
    Price: <path d="M13 14H11V12H13V14ZM17 14H15V12H17V14ZM9 14H7V12H9V14ZM20.71 4.71L19.3 3.3C18.9 2.9 18.3 2.9 18 3.3L17.3 4C19.3 6 21.4 8.1 21.4 8.1L20.71 8.8C20.5 9 20.3 9.1 20 9.1H15V19C15 20.1 14.1 21 13 21H5C3.9 21 3 20.1 3 19V5C3 3.9 3.9 3 5 3H12V2.8L12.7 2.1C13.1 1.7 13.7 1.7 14.1 2.1L14.8 2.8L15.5 2.1C15.9 1.7 16.5 1.7 16.9 2.1L18.3 3.5C18.5 3.7 18.6 3.9 18.6 4.1C18.6 4.4 18.5 4.6 18.3 4.8L20.71 4.71ZM13 18H5V5H13V18Z" fill="currentColor" />,
    Vendors: <path d="M12 7V3H2V21H22V7H12ZM6 19H4V17H6V19ZM6 15H4V13H6V15ZM6 11H4V9H6V11ZM6 7H4V5H6V7ZM10 19H8V17H10V19ZM10 15H8V13H10V15ZM10 11H8V9H10V11ZM10 7H8V5H10V7ZM20 19H12V17H20V19ZM20 15H12V13H20V15ZM20 11H12V9H20V11Z" fill="currentColor" />,
    Summary: <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM9 17H7V10H9V17ZM13 17H11V7H13V17ZM17 17H15V13H17V17Z" fill="currentColor" />,
    Email: <path d="M20 4H4C2.9 4 2 4.9 2 6V18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V6C22 4.9 21.1 4 20 4ZM20 8L12 13L4 8V6L12 11L20 6V8Z" fill="currentColor" />,
    Camera: <path d="M9 2L7.17 4H4C2.9 4 2 4.9 2 6V18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V6C22 4.9 21.1 4 20 4H16.83L15 2H9ZM12 17C9.24 17 7 14.76 7 12C7 9.24 9.24 7 12 7C14.76 7 17 9.24 17 12C17 14.76 14.76 17 12 17ZM12 9C10.34 9 9 10.34 9 12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12C15 10.34 13.66 9 12 9Z" fill="currentColor" />,
    Refresh: <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4C7.58 4 4.01 7.58 4.01 12C4.01 16.42 7.58 20 12 20C15.73 20 18.84 17.45 19.73 14H17.65C16.83 16.33 14.61 18 12 18C8.69 18 6 15.31 6 12C6 8.69 8.69 6 12 6C13.66 6 15.14 6.69 16.22 7.78L13 11H20V4L17.65 6.35Z" fill="currentColor" />,
    Csv: <path d="M19 9H15V3H9V9H5L12 16L19 9ZM5 18V20H19V18H5Z" fill="currentColor" />,
    Lock: <path d="M18 8H17V6C17 3.24 14.76 1 12 1C9.24 1 7 3.24 7 6V8H6C4.9 8 4 8.9 4 10V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V10C20 8.9 19.1 8 18 8ZM12 17C10.9 17 10 16.1 10 15C10 13.9 10.9 13 12 13C13.1 13 14 13.9 14 15C14 16.1 13.1 17 12 17ZM15.1 8H8.9V6C8.9 4.29 10.29 2.9 12 2.9C13.71 2.9 15.1 4.29 15.1 6V8Z" fill="currentColor" />,
    Shield: <path d="M12 1L3 5V11C3 16.55 6.84 21.74 12 23C17.16 21.74 21 16.55 21 11V5L12 1ZM12 11.99H19C18.47 16.11 15.72 19.78 12 20.93V12H5V6.3L12 3.19V11.99Z" fill="currentColor" />
};

// ═══════════════════════════════════════════════════════════════
// LOCK SCREEN COMPONENT
// ═══════════════════════════════════════════════════════════════

function LockScreen({ onUnlock }) {
    const [pin, setPin] = useState("");
    const [error, setError] = useState("");
    const [isSetup, setIsSetup] = useState(false);
    const [confirmPin, setConfirmPin] = useState("");
    const [step, setStep] = useState("check"); // check, setup, enter

    useEffect(() => {
        const hasPin = localStorage.getItem("pt-pin-hash");
        setStep(hasPin ? "enter" : "setup");
    }, []);

    const hashPin = async (p) => {
        const encoded = new TextEncoder().encode(p + "pt-salt-hipaa");
        const hash = await crypto.subtle.digest("SHA-256", encoded);
        return btoa(String.fromCharCode(...new Uint8Array(hash)));
    };

    const handleSetup = async () => {
        if (pin.length < 4) { setError("PIN must be at least 4 digits"); return; }
        if (pin !== confirmPin) { setError("PINs do not match"); return; }
        const hash = await hashPin(pin);
        localStorage.setItem("pt-pin-hash", hash);
        await auditLog("PIN_CREATED");
        onUnlock();
    };

    const handleLogin = async () => {
        const hash = await hashPin(pin);
        const stored = localStorage.getItem("pt-pin-hash");
        if (hash === stored) {
            await auditLog("LOGIN_SUCCESS");
            onUnlock();
        } else {
            await auditLog("LOGIN_FAILED");
            setError("Incorrect PIN");
            setPin("");
        }
    };

    const inputStyle = {
        padding: "14px 20px", borderRadius: 12, border: "1px solid #2a2a3a",
        background: "#0e0e18", color: "#fff", fontSize: 20, textAlign: "center",
        letterSpacing: 12, outline: "none", width: 220, fontFamily: "monospace"
    };

    return (
        <div style={{ minHeight: "100vh", background: "#08080e", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, sans-serif" }}>
            <div style={{ textAlign: "center", color: "#ddd" }}>
                <svg width="48" height="48" viewBox="0 0 24 24" style={{ color: "#f80", marginBottom: 16 }}>{Icons.Shield}</svg>
                <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700 }}>
                    <span style={{ color: "#f80" }}>◆</span> Product Tracker
                </h2>
                <div style={{ fontSize: 11, color: "#556", marginBottom: 32 }}>HIPAA-Compliant · Encrypted Storage</div>

                {step === "setup" && (
                    <div>
                        <div style={{ fontSize: 13, color: "#aab", marginBottom: 16 }}>Create a PIN to secure your data</div>
                        <input
                            type="password" placeholder="Set PIN" maxLength={8}
                            value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }}
                            style={{ ...inputStyle, marginBottom: 12 }}
                            autoFocus
                        />
                        <br />
                        <input
                            type="password" placeholder="Confirm" maxLength={8}
                            value={confirmPin} onChange={e => { setConfirmPin(e.target.value.replace(/\D/g, "")); setError(""); }}
                            style={{ ...inputStyle, marginBottom: 16 }}
                        />
                        <br />
                        <button onClick={handleSetup} style={{ padding: "12px 40px", borderRadius: 10, border: "none", background: "#f80", color: "#000", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                            Create PIN
                        </button>
                    </div>
                )}

                {step === "enter" && (
                    <div>
                        <div style={{ fontSize: 13, color: "#aab", marginBottom: 16 }}>Enter your PIN to unlock</div>
                        <input
                            type="password" placeholder="• • • •" maxLength={8}
                            value={pin}
                            onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }}
                            onKeyDown={e => e.key === "Enter" && handleLogin()}
                            style={inputStyle}
                            autoFocus
                        />
                        <br /><br />
                        <button onClick={handleLogin} style={{ padding: "12px 40px", borderRadius: 10, border: "none", background: "#f80", color: "#000", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                            Unlock
                        </button>
                    </div>
                )}

                {error && <div style={{ color: "#f44", fontSize: 12, marginTop: 12 }}>{error}</div>}
                <div style={{ fontSize: 10, color: "#334", marginTop: 32 }}>🔒 Data encrypted with AES-256-GCM</div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════

export default function App() {
    const [locked, setLocked] = useState(true);
    const [sys, setSys] = useState("test");
    const [entries, setEntries] = useState([]);
    const [tab, setTab] = useState("products");
    const [q, setQ] = useState("");
    const [vf, setVf] = useState("All");
    const [showAudit, setShowAudit] = useState(false);
    const [auditLogs, setAuditLogs] = useState([]);
    const lastActivity = useRef(Date.now());
    const timeoutRef = useRef(null);

    // 4. SESSION TIMEOUT — auto-lock after inactivity
    const resetTimeout = useCallback(() => {
        lastActivity.current = Date.now();
    }, []);

    useEffect(() => {
        if (locked) return;
        const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
        events.forEach(e => window.addEventListener(e, resetTimeout));

        timeoutRef.current = setInterval(() => {
            if (Date.now() - lastActivity.current > SESSION_TIMEOUT_MS) {
                setLocked(true);
                auditLog("SESSION_TIMEOUT");
            }
        }, 10000);

        return () => {
            events.forEach(e => window.removeEventListener(e, resetTimeout));
            clearInterval(timeoutRef.current);
        };
    }, [locked, resetTimeout]);

    // Load data on unlock
    useEffect(() => {
        if (locked) return;
        (async () => {
            const CFG = SYSTEMS[sys];
            const data = await secureStorage.get(CFG.prefix + "-products-v3");
            setEntries(data && data.length > 0 ? data : SEED);
            auditLog("DATA_LOADED", { system: sys });
        })();
    }, [locked, sys]);

    const handleUnlock = () => {
        setLocked(false);
        lastActivity.current = Date.now();
    };

    // Show lock screen
    if (locked) return <LockScreen onUnlock={handleUnlock} />;

    const CFG = SYSTEMS[sys];
    const totalCost = entries.reduce((a, b) => a + (b.cost || 0), 0);
    const uniqueProds = new Set(entries.map(e => e.productName)).size;

    const S = {
        bg: "#08080e", card: "#12121e", border: "#1a1a28", accent: "#f80", textMain: "#eee", textSub: "#778",
        gridBtn: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, background: "transparent", border: "none", color: "#667", fontSize: 13, padding: 12, borderRadius: 12, cursor: "pointer", transition: "0.2s" },
        gridBtnActive: { background: "#1a1a2e", color: "#fff" },
        badge: (c, bg) => ({ padding: "3px 8px", borderRadius: 4, background: bg, color: c, fontSize: 10, fontWeight: 700 }),
        pill: { background: "#1a1a28", padding: "8px 16px", borderRadius: 8, border: "1px solid #2a2a35", color: "#ccc", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }
    };

    return (
        <div style={{ background: S.bg, minHeight: "100vh", color: S.textMain, fontFamily: "Inter, sans-serif", paddingBottom: 40 }}>
            {/* Header */}
            <div style={{ padding: "16px 20px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 18, fontWeight: 700 }}>
                        <span style={{ color: S.accent }}>◆</span> Product Tracker
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => { setLocked(true); auditLog("MANUAL_LOCK"); }} title="Lock" style={{ background: "#2a2a3a", border: "none", borderRadius: "50%", width: 32, height: 32, color: "#f44", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                            <svg width="16" height="16" viewBox="0 0 24 24">{Icons.Lock}</svg>
                        </button>
                        <button style={{ background: "#2a2a3a", border: "none", borderRadius: "50%", width: 32, height: 32, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                            <svg width="18" height="18" viewBox="0 0 24 24">{Icons.Camera}</svg>
                        </button>
                    </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: S.textSub, marginBottom: 16 }}>
                    <span>{entries.length} items · {uniqueProds} products · {fmt(totalCost)}</span>
                    <span style={{ ...S.badge("#4f4", "rgba(68, 255, 68, 0.1)"), border: "1px solid rgba(68, 255, 68, 0.2)" }}>🔒 ENCRYPTED</span>
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                    <select value={sys} onChange={e => setSys(e.target.value)} style={{ ...S.pill, background: "#121217", appearance: "none", paddingRight: 32, cursor: "pointer", color: S.accent, fontWeight: 600 }}>
                        {Object.keys(SYSTEMS).map(k => <option key={k} value={k}>{SYSTEMS[k].label}</option>)}
                    </select>
                    <button style={{ ...S.pill, width: 40, justifyContent: "center", padding: 0, cursor: "pointer" }}>
                        <svg width="16" height="16" viewBox="0 0 24 24">{Icons.Refresh}</svg>
                    </button>
                    <button style={{ ...S.pill, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" style={{ marginTop: -1 }}>{Icons.Csv}</svg> CSV
                    </button>
                </div>
            </div>

            {/* Grid Navigation */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", padding: "0 12px", marginBottom: 24 }}>
                {[
                    ["Products", Icons.Products, "products"],
                    ["+ Add", Icons.Add, "add"],
                    ["Patients", Icons.Patients, "patients"],
                    ["MiMedx", Icons.MiMedx, "mimedx"],
                    ["Commission", Icons.Commission, "commission"],
                    ["Price Sheets", Icons.Price, "prices"],
                    ["Vendors", Icons.Vendors, "vendors"],
                    ["Summary", Icons.Summary, "summary"],
                    ["Audit Log", Icons.Shield, "audit"],
                ].map(([l, i, k]) => (
                    <button key={k} onClick={() => { setTab(k); if (k === "audit") loadAuditLogs(); }} style={{ ...S.gridBtn, ...(tab === k ? S.gridBtnActive : {}) }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" style={{ opacity: tab === k ? 1 : 0.5 }}>{i}</svg>
                        <span>{l}</span>
                    </button>
                ))}
            </div>

            <div style={{ padding: "0 16px" }}>
                <input placeholder="Search..." value={q} onChange={e => setQ(e.target.value)}
                    style={{ width: "100%", padding: "12px 16px", borderRadius: 10, background: "transparent", border: "1px solid #2a2a35", color: "#fff", marginBottom: 10, fontSize: 13, outline: "none" }} />

                <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                    <button style={{ ...S.pill, flex: 1, justifyContent: "center", fontSize: 12 }}>All Vendors</button>
                    <button style={{ ...S.pill, flex: 1, justifyContent: "center", fontSize: 12 }}>All Facilities</button>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <button style={{ ...S.pill, padding: "6px 12px", fontSize: 12 }}>Chronological</button>
                    <span style={{ fontSize: 11, color: S.textSub }}>{entries.length} items · {fmt(totalCost)}</span>
                </div>

                {/* PRODUCTS TABLE */}
                {tab === "products" && (
                    <div style={{ background: "#0e0e12", border: "1px solid #1a1a25", borderRadius: 10, overflow: "hidden" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "45px 70px 90px 1fr 60px", padding: "10px 12px", borderBottom: "1px solid #1a1a25", fontSize: 10, fontWeight: 700, color: S.accent, letterSpacing: 0.5 }}>
                            <div>FAC</div><div>VENDOR</div><div>DOS</div><div>PRODUCT</div><div style={{ textAlign: "right" }}>ITEM</div>
                        </div>
                        {entries.map(e => (
                            <div key={e.id} style={{ display: "grid", gridTemplateColumns: "45px 70px 90px 1fr 60px", padding: "14px 12px", borderBottom: "1px solid #121219", alignItems: "center", fontSize: 12 }}>
                                <div>
                                    <span style={{ padding: "2px 5px", borderRadius: 4, background: e.facility === "Northside" ? "rgba(255,0,170,0.15)" : "rgba(0,170,255,0.15)", color: e.facility === "Northside" ? "#f0a" : "#0af", fontSize: 10, fontWeight: 700 }}>
                                        {e.facility === "Northside" ? "NS" : "NEGA"}
                                    </span>
                                </div>
                                <div style={{ color: "#eee" }}>{e.vendor}</div>
                                <div style={{ color: "#667", fontFamily: "monospace", fontSize: 11 }}>{e.date}</div>
                                <div style={{ color: "#fff", fontWeight: 700 }}>{e.productName}</div>
                                <div style={{ textAlign: "right", color: "#556", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.itemNumber}</div>
                            </div>
                        ))}
                    </div>
                )}

                {/* AUDIT LOG */}
                {tab === "audit" && (
                    <div style={{ background: "#0e0e12", border: "1px solid #1a1a25", borderRadius: 10, overflow: "hidden" }}>
                        <div style={{ padding: "12px 16px", borderBottom: "1px solid #1a1a25", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: S.accent }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" style={{ verticalAlign: "middle", marginRight: 6 }}>{Icons.Shield}</svg>
                                Audit Log
                            </div>
                            <span style={{ fontSize: 10, color: "#556" }}>{auditLogs.length} events</span>
                        </div>
                        {auditLogs.length === 0 ? (
                            <div style={{ padding: 20, textAlign: "center", color: "#445", fontSize: 12 }}>No audit events recorded</div>
                        ) : (
                            auditLogs.slice(-50).reverse().map((log, i) => (
                                <div key={i} style={{ padding: "10px 16px", borderBottom: "1px solid #121219", fontSize: 11, display: "flex", justifyContent: "space-between" }}>
                                    <div>
                                        <span style={{ color: log.action.includes("FAIL") ? "#f44" : log.action.includes("LOCK") || log.action.includes("TIMEOUT") ? "#fa0" : "#4f4", fontWeight: 700, marginRight: 8 }}>
                                            {log.action}
                                        </span>
                                        {log.system && <span style={{ color: "#556" }}>({log.system})</span>}
                                    </div>
                                    <span style={{ color: "#445", fontFamily: "monospace", fontSize: 10 }}>
                                        {new Date(log.timestamp).toLocaleString()}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                )}

                {tab === "add" && (
                    <div style={{ padding: 20, textAlign: "center", color: "#667", background: "#121219", borderRadius: 10 }}>
                        Add Form Placeholder
                    </div>
                )}
            </div>
        </div>
    );

    async function loadAuditLogs() {
        const logs = (await secureStorage.get("pt-audit-log")) || [];
        setAuditLogs(logs);
    }
}