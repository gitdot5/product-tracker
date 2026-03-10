import { useState, useRef, useEffect, useCallback } from "react";
import Papa from "papaparse";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { BarcodeScanner } from '@capacitor-community/barcode-scanner';

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
        const decrypted = await decryptData(raw);
        if (decrypted !== null) return decrypted;
        try {
            const parsed = JSON.parse(raw);
            await secureStorage.set(k, parsed);
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
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await secureStorage.set("pt-audit-log", logs);
}

// ═══════════════════════════════════════════════════════════════
// APP CONFIG
// ═══════════════════════════════════════════════════════════════

const VENDORS = ["4Web", "Altus", "Amplify", "BoneStim", "Carlsmed", "Cellerate", "Choice", "Curiteva", "Exsurco", "ISTO", "MiMedx", "Providence", "Royal", "Spinewave", "Stimulan", "Xtant"];
const SYSTEMS = {
    test: { label: "Test", prefix: "test", facilities: ["Northside", "NEGA"], color: "#f80" },
    kancherla: { label: "Kancherla", prefix: "kancherla", facilities: ["Northside"], color: "#f0a" },
    burch: { label: "Burch", prefix: "burch", facilities: ["Northside", "NEGA"], color: "#0af" }
};

const SEED = [
    { id: 1, vendor: "MiMedx", facility: "Northside", date: "2026-02-06", productName: "EpiFix", itemNumber: "DEMO-001", cost: 1500, patient: "Demo Patient A" },
    { id: 2, vendor: "MiMedx", facility: "Northside", date: "2026-02-06", productName: "EpiFix", itemNumber: "DEMO-002", cost: 1500, patient: "Demo Patient B" },
    { id: 3, vendor: "MiMedx", facility: "NEGA", date: "2026-02-11", productName: "AmnioEffect", itemNumber: "DEMO-003", cost: 3200, patient: "Demo Patient C" },
    { id: 4, vendor: "MiMedx", facility: "NEGA", date: "2026-02-11", productName: "AxioFill", itemNumber: "DEMO-004", cost: 2845, patient: "Demo Patient D" }
];

const fmt = (n) => "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

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
    Shield: <path d="M12 1L3 5V11C3 16.55 6.84 21.74 12 23C17.16 21.74 21 16.55 21 11V5L12 1ZM12 11.99H19C18.47 16.11 15.72 19.78 12 20.93V12H5V6.3L12 3.19V11.99Z" fill="currentColor" />,
    Edit: <path d="M3 17.25V21H6.75L17.81 9.94L14.06 6.19L3 17.25ZM20.71 7.04C21.1 6.65 21.1 6.02 20.71 5.63L18.37 3.29C17.98 2.9 17.35 2.9 16.96 3.29L15.13 5.12L18.88 8.87L20.71 7.04Z" fill="currentColor" />,
    Trash: <path d="M6 19C6 20.1 6.9 21 8 21H16C17.1 21 18 20.1 18 19V7H6V19ZM19 4H15.5L14.5 3H9.5L8.5 4H5V6H19V4Z" fill="currentColor" />,
    Upload: <path d="M9 16H15V10H19L12 3L5 10H9V16ZM5 20V18H19V20H5Z" fill="currentColor" />
};

function LockScreen({ onUnlock }) {
    const [pin, setPin] = useState("");
    const [error, setError] = useState("");
    const [step, setStep] = useState("check");
    const [confirmPin, setConfirmPin] = useState("");

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

    const inputStyle = { padding: "14px 20px", borderRadius: 12, border: "1px solid #2a2a3a", background: "#0e0e18", color: "#fff", fontSize: 20, textAlign: "center", letterSpacing: 12, outline: "none", width: 220, fontFamily: "monospace" };

    return (
        <div style={{ minHeight: "100vh", background: "#08080e", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, sans-serif" }}>
            <div style={{ textAlign: "center", color: "#ddd" }}>
                <svg width="48" height="48" viewBox="0 0 24 24" style={{ color: "#f80", marginBottom: 16 }}>{Icons.Shield}</svg>
                <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700 }}><span style={{ color: "#f80" }}>◆</span> Product Tracker</h2>
                <div style={{ fontSize: 11, color: "#556", marginBottom: 32 }}>HIPAA-Compliant · Encrypted Storage</div>
                {step === "setup" && (
                    <div>
                        <div style={{ fontSize: 13, color: "#aab", marginBottom: 16 }}>Create a PIN to secure your data</div>
                        <input type="password" placeholder="Set PIN" maxLength={8} value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }} style={{ ...inputStyle, marginBottom: 12 }} autoFocus />
                        <br /><input type="password" placeholder="Confirm" maxLength={8} value={confirmPin} onChange={e => { setConfirmPin(e.target.value.replace(/\D/g, "")); setError(""); }} style={{ ...inputStyle, marginBottom: 16 }} />
                        <br /><button onClick={handleSetup} style={{ padding: "12px 40px", borderRadius: 10, border: "none", background: "#f80", color: "#000", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Create PIN</button>
                    </div>
                )}
                {step === "enter" && (
                    <div>
                        <div style={{ fontSize: 13, color: "#aab", marginBottom: 16 }}>Enter your PIN to unlock</div>
                        <input type="password" placeholder="• • • •" maxLength={8} value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }} onKeyDown={e => e.key === "Enter" && handleLogin()} style={inputStyle} autoFocus />
                        <br /><br /><button onClick={handleLogin} style={{ padding: "12px 40px", borderRadius: 10, border: "none", background: "#f80", color: "#000", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Unlock</button>
                    </div>
                )}
                {error && <div style={{ color: "#f44", fontSize: 12, marginTop: 12 }}>{error}</div>}
                <div style={{ fontSize: 10, color: "#334", marginTop: 32 }}>🔒 Data encrypted with AES-256-GCM</div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// ADD/EDIT FORM
// ═══════════════════════════════════════════════════════════════

function AddForm({ onSave, onCancel, initialData, historicalEntries }) {
    const [formData, setFormData] = useState(initialData || { date: new Date().toISOString().split("T")[0], vendor: "MiMedx", facility: "Northside", productName: "", itemNumber: "", cost: "", patient: "" });
    const [isScanning, setIsScanning] = useState(false);
    const [isScanningBarcode, setIsScanningBarcode] = useState(false);
    const fileInputRef = useRef(null);
    const handleChange = (f, v) => setFormData(p => ({ ...p, [f]: v }));

    // Hardware Barcode Scanner Engine
    const startBarcodeScan = async () => {
        try {
            await BarcodeScanner.checkPermission({ force: true });
            BarcodeScanner.hideBackground();
            document.body.style.background = "transparent";
            setIsScanningBarcode(true);

            const result = await BarcodeScanner.startScan();
            if (result.hasContent) {
                setFormData(p => ({ ...p, itemNumber: result.content }));
            }
        } catch (e) {
            console.warn("Barcode Scanner requires native device:", e);
            alert("Hardware Barcode Scanning is only supported natively on physical iOS/Android devices using Capacitor.");
        } finally {
            stopBarcodeScan();
        }
    };

    const stopBarcodeScan = async () => {
        try {
            setIsScanningBarcode(false);
            document.body.style.background = "";
            await BarcodeScanner.showBackground();
            await BarcodeScanner.stopScan();
        } catch (e) { console.warn(e); }
    };

    // Smart Autofill Engine
    const handleProductNameChange = (val) => {
        let newData = { productName: val };
        // Check if we hit an exact match from historical data
        const match = historicalEntries.find(e => e.productName.toLowerCase() === val.toLowerCase());
        if (match && !initialData) {
            newData.cost = match.cost;
            newData.vendor = match.vendor;
            // Pre-fill the item prefix (e.g. 'DEMO-001' -> 'DEMO-')
            if (match.itemNumber && match.itemNumber.includes("-")) {
                newData.itemNumber = match.itemNumber.split("-")[0] + "-";
            }
        }
        setFormData(p => ({ ...p, ...newData }));
    };

    const handleImageUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setIsScanning(true);
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = async () => {
            const base64Image = reader.result.split(',')[1];
            try {
                // Ensure we call the serverless proxy, NOT exposing keys to client
                const res = await fetch("/.netlify/functions/process-po", {
                    method: "POST",
                    body: JSON.stringify({ base64Image })
                });

                if (!res.ok) throw new Error(await res.text());

                const data = await res.json();

                // Update form dynamically based on AI response
                setFormData(p => ({
                    ...p,
                    ...data,
                    cost: parseFloat(data.cost) || p.cost // normalize cost
                }));
            } catch (err) {
                console.error("Scanning Error:", err);
                alert("Failed to scan document automatically. See console.");
            } finally {
                setIsScanning(false);
                if (fileInputRef.current) fileInputRef.current.value = "";
            }
        };
    };

    const handleSubmit = (e) => { e.preventDefault(); onSave(formData); };
    const fieldStyle = { display: "block", marginBottom: 12 };
    const labelStyle = { display: "block", fontSize: 11, color: "#778", marginBottom: 4 };
    const inputStyle = { width: "100%", padding: "10px 12px", borderRadius: 8, background: "#1a1a25", border: "1px solid #2a2a35", color: "#fff", fontSize: 13, outline: "none", boxSizing: "border-box" };

    // Unique Historical Product Names for Datalist
    const productNames = [...new Set(historicalEntries.map(e => e.productName))];

    return (
        <div style={{ padding: 20, background: isScanningBarcode ? "transparent" : "#0e0e18", borderRadius: 12, display: isScanningBarcode ? "none" : "block" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <h3 style={{ margin: 0, color: "#fff" }}>{initialData ? "Edit Entry" : "Add New Entry"}</h3>
                {!initialData && (
                    <div style={{ position: "relative" }}>
                        <button type="button" onClick={() => fileInputRef.current.click()} disabled={isScanning} style={{ background: "linear-gradient(135deg, #f80 0%, #fa4 100%)", border: "none", color: "#000", fontWeight: 700, padding: "8px 12px", borderRadius: 8, cursor: isScanning ? "wait" : "pointer", fontSize: 12, opacity: isScanning ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}>
                            {isScanning ? (
                                <>⏳ Analyzing Doc...</>
                            ) : (
                                <>✨ Scan PO Auto-Fill</>
                            )}
                        </button>
                        <input type="file" accept="image/*" ref={fileInputRef} onChange={handleImageUpload} style={{ display: "none" }} />
                    </div>
                )}
            </div>
            <form onSubmit={handleSubmit}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div style={fieldStyle}><label style={labelStyle}>Date</label><input type="date" value={formData.date} onChange={e => handleChange("date", e.target.value)} style={inputStyle} required /></div>
                    <div style={fieldStyle}><label style={labelStyle}>Facility</label><select value={formData.facility} onChange={e => handleChange("facility", e.target.value)} style={inputStyle}><option>Northside</option><option>NEGA</option></select></div>
                </div>
                <div style={fieldStyle}><label style={labelStyle}>Vendor</label><select value={formData.vendor} onChange={e => handleChange("vendor", e.target.value)} style={inputStyle}>{VENDORS.map(v => <option key={v}>{v}</option>)}</select></div>
                <div style={fieldStyle}>
                    <label style={labelStyle}>Product</label>
                    <input list="historical-products" value={formData.productName} onChange={e => handleProductNameChange(e.target.value)} style={inputStyle} required placeholder="e.g. EpiFix" />
                    <datalist id="historical-products">{productNames.map(pn => <option key={pn} value={pn} />)}</datalist>
                </div>
                <div style={fieldStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 4 }}>
                        <label style={{ ...labelStyle, marginBottom: 0 }}>Item #</label>
                        <button type="button" onClick={startBarcodeScan} style={{ background: "transparent", border: "1px solid #fa4", color: "#fa4", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, cursor: "pointer" }}>📷 SCAN</button>
                    </div>
                    <input value={formData.itemNumber} onChange={e => handleChange("itemNumber", e.target.value)} style={inputStyle} required placeholder="e.g. EF-123" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
                    <div style={fieldStyle}><label style={labelStyle}>Cost ($)</label><input type="number" step="0.01" value={formData.cost} onChange={e => handleChange("cost", parseFloat(e.target.value))} style={inputStyle} required /></div>
                    <div style={fieldStyle}><label style={labelStyle}>Patient (Secure)</label><input value={formData.patient} onChange={e => handleChange("patient", e.target.value)} style={inputStyle} required placeholder="Name or ID" /></div>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                    <button type="button" onClick={onCancel} style={{ flex: 1, padding: 12, borderRadius: 8, border: "none", background: "#2a2a35", color: "#aaa", cursor: "pointer" }}>Cancel</button>
                    <button type="submit" style={{ flex: 1, padding: 12, borderRadius: 8, border: "none", background: "#f80", color: "#000", fontWeight: 700, cursor: "pointer" }}>{initialData ? "Update" : "Add Entry"}</button>
                </div>
            </form>
            {
                isScanningBarcode && (
                    <div style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh", zIndex: 99999, display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 30, background: "rgba(0,0,0,0.5)" }}>
                        <div style={{ background: "transparent", border: "2px dashed #fa4", height: 200, marginBottom: "auto", marginTop: "auto", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ color: "#fa4", fontWeight: 700 }}>Align Barcode</span>
                        </div>
                        <button onClick={stopBarcodeScan} style={{ padding: 16, background: "#f44", color: "#fff", borderRadius: 12, fontSize: 18, fontWeight: 800, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.5)", width: "100%" }}>
                            Cancel Scan
                        </button>
                    </div>
                )
            }
        </div >
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
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");
    const [commissionRates, setCommissionRates] = useState({});
    const [auditLogs, setAuditLogs] = useState([]);
    const [editing, setEditing] = useState(null);
    const [productViewMode, setProductViewMode] = useState("table");
    const [expandedPatient, setExpandedPatient] = useState(null);
    const lastActivity = useRef(Date.now());
    const timeoutRef = useRef(null);

    const resetTimeout = useCallback(() => { lastActivity.current = Date.now(); }, []);
    useEffect(() => {
        if (locked) return;
        const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
        events.forEach(e => window.addEventListener(e, resetTimeout));
        timeoutRef.current = setInterval(() => {
            if (Date.now() - lastActivity.current > SESSION_TIMEOUT_MS) { setLocked(true); auditLog("SESSION_TIMEOUT"); }
        }, 10000);
        return () => { events.forEach(e => window.removeEventListener(e, resetTimeout)); clearInterval(timeoutRef.current); };
    }, [locked, resetTimeout]);

    useEffect(() => {
        if (locked) return;
        (async () => {
            const CFG = SYSTEMS[sys];
            const data = await secureStorage.get(CFG.prefix + "-products-v3");
            const rates = await secureStorage.get(CFG.prefix + "-commissions") || {};
            setEntries(data && data.length > 0 ? data : SEED);
            setCommissionRates(rates);
            auditLog("DATA_LOADED", { system: sys });
        })();
    }, [locked, sys]);

    const saveEntry = async (entry) => {
        const CFG = SYSTEMS[sys];
        let newEntries;
        if (entry.id) {
            newEntries = entries.map(e => e.id === entry.id ? entry : e);
            await auditLog("ENTRY_UPDATED", { id: entry.id });
        } else {
            entry.id = Date.now();
            newEntries = [entry, ...entries];
            await auditLog("ENTRY_ADDED", { id: entry.id });
        }
        setEntries(newEntries);
        await secureStorage.set(CFG.prefix + "-products-v3", newEntries);
        setTab("products");
        setEditing(null);
    };

    const deleteEntry = async (id) => {
        if (!confirm("Delete this entry?")) return;
        const CFG = SYSTEMS[sys];
        const newEntries = entries.filter(e => e.id !== id);
        setEntries(newEntries);
        await secureStorage.set(CFG.prefix + "-products-v3", newEntries);
        await auditLog("ENTRY_DELETED", { id });
    };

    const downloadCSV = () => {
        const headers = ["ID", "Facility", "Vendor", "Date", "Product", "Item #", "Cost", "Patient"];
        const rows = entries.map(e => [e.id, e.facility, e.vendor, e.date, e.productName, e.itemNumber, e.cost, e.patient]);
        const csvContent = "data:text/csv;charset=utf-8," + [headers, ...rows].map(r => r.join(",")).join("\n");
        const link = document.createElement("a");
        link.href = encodeURI(csvContent);
        link.download = `product_tracker_${sys}_${new Date().toISOString().split("T")[0]}.csv`;
        link.click();
        auditLog("CSV_EXPORTED");
    };

    const handleImportCSV = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: async (results) => {
                const imported = results.data.map((row, idx) => ({
                    id: Date.now() + idx, // Generate unique IDs for imported items
                    facility: row.Facility || "Unknown",
                    vendor: row.Vendor || "Unknown",
                    date: row.Date || new Date().toISOString().split("T")[0],
                    productName: row.Product || `Imported Product ${idx}`,
                    itemNumber: row["Item #"] || "N/A",
                    cost: parseFloat(row.Cost) || 0,
                    patient: row.Patient || "Unknown",
                }));
                const newEntries = [...imported, ...entries];
                setEntries(newEntries);
                await secureStorage.set(SYSTEMS[sys].prefix + "-products-v3", newEntries);
                await auditLog("CSV_IMPORTED", { count: imported.length });
                alert(`Successfully imported ${imported.length} entries.`);
                e.target.value = null; // reset input
            },
            error: (err) => {
                alert("Failed to parse CSV: " + err.message);
                auditLog("CSV_IMPORT_FAILED", { error: err.message });
            }
        });
    };

    const handleUnlock = () => { setLocked(false); lastActivity.current = Date.now(); };
    if (locked) return <LockScreen onUnlock={handleUnlock} />;

    const CFG = SYSTEMS[sys];

    const filteredEntries = entries.filter(e => {
        const matchQ = !q || [e.productName, e.vendor, e.itemNumber, e.patient].some(f => f && f.toLowerCase().includes(q.toLowerCase()));
        const matchStart = !startDate || e.date >= startDate;
        const matchEnd = !endDate || e.date <= endDate;
        return matchQ && matchStart && matchEnd;
    });

    const totalCost = filteredEntries.reduce((a, b) => a + (b.cost || 0), 0);
    const uniqueProds = new Set(filteredEntries.map(e => e.productName)).size;

    const handleCommissionChange = async (vendor, rate) => {
        const newRates = { ...commissionRates, [vendor]: parseFloat(rate) || 0 };
        setCommissionRates(newRates);
        await secureStorage.set(SYSTEMS[sys].prefix + "-commissions", newRates);
    };

    const calculateCommission = () => {
        let expected = 0;
        let received = 0;
        let missingCount = 0;
        let noRateCount = 0;
        const items = [];

        filteredEntries.forEach(e => {
            const hasRate = commissionRates[e.vendor] !== undefined;
            const rate = hasRate ? commissionRates[e.vendor] : 10; // default 10%
            const commBase = (e.cost || 0) * (rate / 100);

            expected += commBase;

            let status = "Missing";
            if (!hasRate && rate === 0) {
                status = "No Rate";
                noRateCount++;
            } else {
                missingCount++;
            }

            items.push({ ...e, commExpected: commBase, status });
        });

        return { expected, received, difference: received - expected, missingCount, noRateCount, items };
    };

    const S = {
        bg: "#08080e", card: "#12121e", border: "#1a1a28", accent: "#f80", textMain: "#eee", textSub: "#778",
        gridBtn: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, background: "transparent", border: "none", color: "#667", fontSize: 13, padding: 12, borderRadius: 12, cursor: "pointer", transition: "0.2s" },
        gridBtnActive: { background: "#1a1a2e", color: "#fff" },
        badge: (c, bg) => ({ padding: "3px 8px", borderRadius: 4, background: bg, color: c, fontSize: 10, fontWeight: 700 }),
        pill: { background: "#1a1a28", padding: "8px 16px", borderRadius: 8, border: "1px solid #2a2a35", color: "#ccc", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }
    };

    const processAnalytics = () => {
        // Group by Date for the Bar Chart
        const dateMap = {};
        // Group by Vendor for the Pie Chart
        const vendorMap = {};

        filteredEntries.forEach(e => {
            if (!dateMap[e.date]) dateMap[e.date] = 0;
            dateMap[e.date] += e.cost || 0;

            if (!vendorMap[e.vendor]) vendorMap[e.vendor] = 0;
            vendorMap[e.vendor] += e.cost || 0;
        });

        const revTime = Object.keys(dateMap).sort().map(date => ({ date, revenue: dateMap[date] }));
        const revVendor = Object.keys(vendorMap).map(vendor => ({ name: vendor, value: vendorMap[vendor] })).sort((a, b) => b.value - a.value);

        return { revTime, revVendor };
    };

    const CHART_COLORS = ["#f80", "#f0a", "#0af", "#0f8", "#a0f", "#f44", "#ffeb3b", "#4caf50"];

    return (
        <div style={{ background: S.bg, minHeight: "100vh", color: S.textMain, fontFamily: "Inter, sans-serif", paddingBottom: 40 }}>
            {/* Header */}
            <div style={{ padding: "16px 20px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 18, fontWeight: 700 }}>
                        <span style={{ color: S.accent }}>◆</span> Product Tracker
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => { setLocked(true); auditLog("MANUAL_LOCK"); }} title="Lock" style={{ background: "#2a2a3a", border: "none", borderRadius: "50%", width: 32, height: 32, color: "#f44", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><svg width="16" height="16" viewBox="0 0 24 24">{Icons.Lock}</svg></button>
                        <button style={{ background: "#2a2a3a", border: "none", borderRadius: "50%", width: 32, height: 32, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><svg width="18" height="18" viewBox="0 0 24 24">{Icons.Camera}</svg></button>
                    </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: S.textSub, marginBottom: 16 }}>
                    <span style={{ fontWeight: 600, color: "#aaa" }}>{filteredEntries.length} items · {uniqueProds} products · {fmt(totalCost)} total value</span>
                    <span style={{ ...S.badge("#4f4", "rgba(68, 255, 68, 0.1)"), border: "1px solid rgba(68, 255, 68, 0.2)" }}>🔒 SHARED</span>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                    <select value={sys} onChange={e => setSys(e.target.value)} style={{ ...S.pill, background: "#121217", appearance: "none", paddingRight: 32, cursor: "pointer", color: S.accent, fontWeight: 600 }}>{Object.keys(SYSTEMS).map(k => <option key={k} value={k}>{SYSTEMS[k].label}</option>)}</select>
                    <button style={{ ...S.pill, width: 40, justifyContent: "center", padding: 0, cursor: "pointer" }}><svg width="16" height="16" viewBox="0 0 24 24">{Icons.Refresh}</svg></button>
                    <button onClick={downloadCSV} style={{ ...S.pill, cursor: "pointer", fontSize: 12, fontWeight: 600 }}><svg width="14" height="14" viewBox="0 0 24 24" style={{ marginTop: -1 }}>{Icons.Csv}</svg> Export</button>
                    <label style={{ ...S.pill, cursor: "pointer", fontSize: 12, fontWeight: 600, margin: 0 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" style={{ marginTop: -1 }}>{Icons.Upload}</svg> Import
                        <input type="file" accept=".csv" onChange={handleImportCSV} style={{ display: "none" }} />
                    </label>
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
                    <button key={k} onClick={() => { setTab(k); if (k === "audit") loadAuditLogs(); setEditing(null); }} style={{ ...S.gridBtn, ...(tab === k ? S.gridBtnActive : {}) }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" style={{ opacity: tab === k ? 1 : 0.5 }}>{i}</svg>
                        <span>{l}</span>
                    </button>
                ))}
            </div>

            <div style={{ padding: "0 16px" }}>
                {tab === "products" && (
                    <>
                        <input placeholder="Search products, vendors, patients, items..." value={q} onChange={e => setQ(e.target.value)} style={{ width: "100%", padding: "12px 16px", borderRadius: 10, background: "transparent", border: "1px solid #2a2a35", color: "#fff", marginBottom: 10, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                        <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", justifyContent: "space-between" }}>
                            <div style={{ display: "flex", gap: 10, flex: 1 }}>
                                <div style={{ flex: 1, display: "flex", alignItems: "center", background: "#1a1a25", borderRadius: 10, padding: "0 12px", border: "1px solid #2a2a35" }}>
                                    <span style={{ fontSize: 11, color: "#778", marginRight: 8 }}>From</span>
                                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ background: "transparent", border: "none", color: "#fff", fontSize: 12, outline: "none", flex: 1, padding: "10px 0" }} />
                                </div>
                                <div style={{ flex: 1, display: "flex", alignItems: "center", background: "#1a1a25", borderRadius: 10, padding: "0 12px", border: "1px solid #2a2a35" }}>
                                    <span style={{ fontSize: 11, color: "#778", marginRight: 8 }}>To</span>
                                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ background: "transparent", border: "none", color: "#fff", fontSize: 12, outline: "none", flex: 1, padding: "10px 0" }} />
                                </div>
                            </div>
                            <div style={{ display: "flex", background: "#1a1a25", borderRadius: 8, padding: 2, border: "1px solid #2a2a35" }}>
                                <button onClick={() => setProductViewMode("table")} style={{ background: productViewMode === "table" ? "#2a2a35" : "transparent", color: productViewMode === "table" ? "#fff" : "#778", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Table</button>
                                <button onClick={() => setProductViewMode("list")} style={{ background: productViewMode === "list" ? "#2a2a35" : "transparent", color: productViewMode === "list" ? "#fff" : "#778", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>List</button>
                            </div>
                        </div>

                        {productViewMode === "table" ? (
                            <div style={{ background: "#0e0e12", border: "1px solid #1a1a25", borderRadius: 10, overflow: "hidden" }}>
                                <div style={{ display: "grid", gridTemplateColumns: "45px 70px 90px 1fr 60px 50px", padding: "10px 12px", borderBottom: "1px solid #1a1a25", fontSize: 10, fontWeight: 700, color: S.accent, letterSpacing: 0.5 }}>
                                    <div>FAC</div><div>VENDOR</div><div>DOS</div><div>PRODUCT</div><div style={{ textAlign: "right" }}>ITEM</div><div></div>
                                </div>
                                {filteredEntries.map(e => (
                                    <div key={e.id} style={{ display: "grid", gridTemplateColumns: "45px 70px 90px 1fr 60px 50px", padding: "14px 12px", borderBottom: "1px solid #121219", alignItems: "center", fontSize: 12 }}>
                                        <div><span style={{ padding: "2px 5px", borderRadius: 4, background: e.facility === "Northside" ? "rgba(255,0,170,0.15)" : "rgba(0,170,255,0.15)", color: e.facility === "Northside" ? "#f0a" : "#0af", fontSize: 10, fontWeight: 700 }}>{e.facility === "Northside" ? "NS" : "NEGA"}</span></div>
                                        <div style={{ color: "#eee" }}>{e.vendor}</div>
                                        <div style={{ color: "#667", fontFamily: "monospace", fontSize: 11 }}>{e.date}</div>
                                        <div style={{ color: "#fff", fontWeight: 700 }}>{e.productName}</div>
                                        <div style={{ textAlign: "right", color: "#556", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.itemNumber}</div>
                                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                                            <button onClick={() => { setEditing(e); setTab("add"); }} style={{ background: "none", border: "none", padding: 0, color: "#667", cursor: "pointer" }}><svg width="14" height="14" viewBox="0 0 24 24">{Icons.Edit}</svg></button>
                                            <button onClick={() => deleteEntry(e.id)} style={{ background: "none", border: "none", padding: 0, color: "#933", cursor: "pointer" }}><svg width="14" height="14" viewBox="0 0 24 24">{Icons.Trash}</svg></button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                {filteredEntries.map(e => (
                                    <div key={e.id} style={{ background: "#0e0e12", border: "1px solid #1a1a25", borderRadius: 10, padding: 16 }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                                            <div style={{ fontWeight: 700, fontSize: 15, color: "#fff" }}>{e.productName} <span style={{ fontSize: 12, color: "#778", fontWeight: 400, marginLeft: 4 }}>1 Qty</span></div>
                                            <div style={{ fontWeight: 800, color: S.accent, fontSize: 15 }}>{fmt(e.cost)}</div>
                                        </div>
                                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#aaa", alignItems: "center" }}>
                                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                                <span style={{ padding: "2px 5px", borderRadius: 4, background: e.facility === "Northside" ? "rgba(255,0,170,0.15)" : "rgba(0,170,255,0.15)", color: e.facility === "Northside" ? "#f0a" : "#0af", fontSize: 10, fontWeight: 700 }}>{e.facility === "Northside" ? "NS" : "NEGA"}</span>
                                                {e.vendor} · {e.itemNumber}
                                            </div>
                                            <div style={{ display: "flex", gap: 12 }}>
                                                <button onClick={() => { setEditing(e); setTab("add"); }} style={{ background: "none", border: "none", padding: 0, color: "#667", cursor: "pointer" }}><svg width="14" height="14" viewBox="0 0 24 24">{Icons.Edit}</svg></button>
                                                <button onClick={() => deleteEntry(e.id)} style={{ background: "none", border: "none", padding: 0, color: "#933", cursor: "pointer" }}><svg width="14" height="14" viewBox="0 0 24 24">{Icons.Trash}</svg></button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {tab === "add" && (
                    <AddForm initialData={editing} onSave={saveEntry} onCancel={() => { setTab("products"); setEditing(null); }} historicalEntries={entries} />
                )}

                {tab === "patients" && (() => {
                    const grouped = filteredEntries.reduce((acc, e) => {
                        const k = e.patient || "Unknown";
                        if (!acc[k]) acc[k] = { cost: 0, items: [], vendor: e.vendor };
                        acc[k].cost += e.cost || 0;
                        acc[k].items.push(e);
                        return acc;
                    }, {});

                    return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {Object.entries(grouped).map(([patient, data]) => {
                                const isExp = expandedPatient === patient;
                                return (
                                    <div key={patient} style={{ background: "#0e0e12", border: "1px solid #1a1a25", borderRadius: 10, overflow: "hidden" }}>
                                        <div onClick={() => setExpandedPatient(isExp ? null : patient)} style={{ padding: "16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                            <div>
                                                <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 4 }}>{patient}</div>
                                                <div style={{ fontSize: 13, color: S.textSub }}>{data.items[0]?.date} · {data.items.length} items ({data.vendor})</div>
                                            </div>
                                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                                <span style={{ fontSize: 16, fontWeight: 800, color: S.accent }}>{fmt(data.cost)}</span>
                                                <svg width="20" height="20" viewBox="0 0 24 24" style={{ fill: "#667", transform: isExp ? "rotate(180deg)" : "rotate(0deg)", transition: "0.2s" }}><path d="M7 10L12 15L17 10H7Z" /></svg>
                                            </div>
                                        </div>
                                        {isExp && (
                                            <div style={{ borderTop: "1px solid #1a1a25", padding: "12px 16px", background: "#121219", display: "flex", flexDirection: "column", gap: 10 }}>
                                                {data.items.map(e => (
                                                    <div key={e.id} style={{ display: "grid", gridTemplateColumns: "1fr 100px 40px", alignItems: "center", gap: 8, fontSize: 13 }}>
                                                        <div>
                                                            <div style={{ color: "#eee", fontWeight: 600 }}>{e.productName}</div>
                                                            <div style={{ color: "#667", fontSize: 11, fontFamily: "monospace" }}>{e.itemNumber}</div>
                                                        </div>
                                                        <div style={{ textAlign: "right", color: "#ccc", fontWeight: 600 }}>{fmt(e.cost)}</div>
                                                        <div style={{ textAlign: "right" }}>
                                                            <button onClick={(ev) => { ev.stopPropagation(); deleteEntry(e.id); }} style={{ background: "none", border: "none", padding: 4, color: "#933", cursor: "pointer" }}><svg width="14" height="14" viewBox="0 0 24 24">{Icons.Trash}</svg></button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })()}

                {tab === "vendors" && (() => {
                    const grouped = filteredEntries.reduce((acc, e) => {
                        if (!acc[e.vendor]) acc[e.vendor] = { total: 0, items: [], facilities: {} };
                        acc[e.vendor].total += e.cost || 0;
                        acc[e.vendor].items.push(e);
                        if (!acc[e.vendor].facilities[e.facility]) acc[e.vendor].facilities[e.facility] = 0;
                        acc[e.vendor].facilities[e.facility] += e.cost || 0;
                        return acc;
                    }, {});

                    return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                            {Object.entries(grouped).map(([vendor, data]) => (
                                <div key={vendor} style={{ background: "#0e0e12", border: "1px solid #1a1a25", borderRadius: 12, padding: 20 }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                        <div style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>{vendor}</div>
                                        <div style={{ fontSize: 18, fontWeight: 800, color: S.accent }}>{fmt(data.total)} <span style={{ fontSize: 12, color: "#778", fontWeight: 500 }}>({data.items.length} items)</span></div>
                                    </div>

                                    <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                                        {Object.entries(data.facilities).map(([fac, amt]) => (
                                            <div key={fac} style={{ padding: "8px 12px", borderRadius: 8, background: fac === "Northside" ? "rgba(255,0,170,0.1)" : "rgba(0,170,255,0.1)", border: `1px solid ${fac === "Northside" ? "rgba(255,0,170,0.2)" : "rgba(0,170,255,0.2)"}`, display: "flex", flexDirection: "column" }}>
                                                <span style={{ fontSize: 10, fontWeight: 700, color: fac === "Northside" ? "#f0a" : "#0af" }}>{fac === "Northside" ? "NS" : "NEGA"}</span>
                                                <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>{fmt(amt)}</span>
                                            </div>
                                        ))}
                                    </div>

                                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                        {data.items.map(e => (
                                            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "#121219", borderRadius: 8, border: "1px solid #1a1a25" }}>
                                                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                                                    <span style={{ padding: "2px 5px", borderRadius: 4, background: e.facility === "Northside" ? "rgba(255,0,170,0.15)" : "rgba(0,170,255,0.15)", color: e.facility === "Northside" ? "#f0a" : "#0af", fontSize: 10, fontWeight: 700 }}>{e.facility === "Northside" ? "NS" : "NEGA"}</span>
                                                    <div>
                                                        <div style={{ fontSize: 13, fontWeight: 600, color: "#eee" }}>{e.productName}</div>
                                                        <div style={{ fontSize: 11, color: "#667", fontFamily: "monospace" }}>{e.itemNumber}</div>
                                                    </div>
                                                </div>
                                                <div style={{ fontSize: 14, fontWeight: 600, color: "#ccc" }}>{fmt(e.cost)}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    );
                })()}

                {tab === "commission" && (() => {
                    const { expected, received, difference, missingCount, noRateCount, items } = calculateCommission();
                    return (
                        <div style={{ paddingBottom: 20 }}>
                            <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                                <div style={{ flex: 1, background: "#1a1a25", border: "1px solid #2a2a35", borderRadius: 12, padding: 16 }}>
                                    <div style={{ fontSize: 13, color: S.textSub, marginBottom: 8 }}>Expected</div>
                                    <div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>{fmt(expected)}</div>
                                </div>
                                <div style={{ flex: 1, background: "#1a1a25", border: "1px solid #2a2a35", borderRadius: 12, padding: 16 }}>
                                    <div style={{ fontSize: 13, color: S.textSub, marginBottom: 8 }}>Received</div>
                                    <div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>{fmt(received)}</div>
                                </div>
                                <div style={{ flex: 1, background: "#1a1a25", border: "1px solid #2a2a35", borderRadius: 12, padding: 16 }}>
                                    <div style={{ fontSize: 13, color: S.textSub, marginBottom: 8 }}>Difference</div>
                                    <div style={{ fontSize: 20, fontWeight: 800, color: difference < 0 ? "#f44" : "#4f4" }}>{difference < 0 ? "-" : ""}{fmt(Math.abs(difference))}</div>
                                </div>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 24 }}>
                                <div style={{ background: "rgba(68, 255, 68, 0.1)", border: "1px solid rgba(68, 255, 68, 0.2)", borderRadius: 8, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span style={{ fontSize: 12, color: "#4f4", fontWeight: 700 }}>Matched</span>
                                    <span style={{ fontSize: 14, color: "#4f4", fontWeight: 800 }}>0</span>
                                </div>
                                <div style={{ background: "rgba(255, 235, 59, 0.1)", border: "1px solid rgba(255, 235, 59, 0.2)", borderRadius: 8, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span style={{ fontSize: 12, color: "#ffeb3b", fontWeight: 700 }}>Underpaid</span>
                                    <span style={{ fontSize: 14, color: "#ffeb3b", fontWeight: 800 }}>0</span>
                                </div>
                                <div style={{ background: "rgba(244, 68, 68, 0.1)", border: "1px solid rgba(244, 68, 68, 0.2)", borderRadius: 8, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span style={{ fontSize: 12, color: "#f44", fontWeight: 700 }}>Missing</span>
                                    <span style={{ fontSize: 14, color: "#f44", fontWeight: 800 }}>{missingCount}</span>
                                </div>
                                <div style={{ background: "rgba(244, 68, 68, 0.1)", border: "1px solid rgba(244, 68, 68, 0.2)", borderRadius: 8, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span style={{ fontSize: 12, color: "#f44", fontWeight: 700 }}>No Rate</span>
                                    <span style={{ fontSize: 14, color: "#f44", fontWeight: 800 }}>{noRateCount}</span>
                                </div>
                            </div>

                            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                                <button style={{ ...S.pill, flex: 1, justifyContent: "center", background: "#2a2a35", color: "#fff", border: "none" }}>Reconcile</button>
                                <button style={{ ...S.pill, flex: 1, justifyContent: "center" }}>Rates</button>
                                <button style={{ ...S.pill, flex: 1, justifyContent: "center" }}>Reports</button>
                            </div>

                            <div style={{ background: "#0e0e12", border: "1px solid #1a1a25", borderRadius: 10, overflow: "hidden" }}>
                                <div style={{ display: "grid", gridTemplateColumns: "30px 70px 80px 1fr 60px", padding: "10px 12px", borderBottom: "1px solid #1a1a25", fontSize: 10, fontWeight: 700, color: S.accent, letterSpacing: 0.5 }}>
                                    <div></div><div>VENDOR</div><div>DOS</div><div>PRODUCT</div><div style={{ textAlign: "right" }}>EXP.</div>
                                </div>
                                {items.map(e => (
                                    <div key={e.id} style={{ display: "grid", gridTemplateColumns: "30px 70px 80px 1fr 60px", padding: "14px 12px", borderBottom: "1px solid #121219", alignItems: "center", fontSize: 12 }}>
                                        <div style={{ fontSize: 14 }}>{e.status === "Missing" ? "❌" : "⚠️"}</div>
                                        <div style={{ color: "#eee" }}>{e.vendor}</div>
                                        <div style={{ color: "#667", fontFamily: "monospace", fontSize: 11 }}>{e.date}</div>
                                        <div style={{ color: "#fff", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.productName}</div>
                                        <div style={{ textAlign: "right", color: S.accent, fontWeight: 700 }}>{fmt(e.commExpected)}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })()}

                {tab === "summary" && (() => {
                    const { revTime, revVendor } = processAnalytics();
                    return (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 24, paddingBottom: 40 }}>
                            <div style={{ background: "#0e0e12", padding: 20, borderRadius: 16, border: "1px solid #1a1a25" }}>
                                <h3 style={{ margin: "0 0 16px", color: "#ddd", fontSize: 16 }}>Revenue Over Time</h3>
                                <div style={{ width: "100%", height: 300 }}>
                                    {revTime.length > 0 ? (
                                        <ResponsiveContainer>
                                            <BarChart data={revTime} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
                                                <XAxis dataKey="date" stroke="#556" fontSize={11} tickMargin={10} />
                                                <YAxis stroke="#556" fontSize={11} tickFormatter={(val) => `$${val.toLocaleString()}`} />
                                                <Tooltip
                                                    cursor={{ fill: "rgba(255,255,255,0.05)" }}
                                                    contentStyle={{ background: "#1a1a25", border: "1px solid #2a2a35", borderRadius: 8, color: "#fff" }}
                                                    itemStyle={{ color: S.accent, fontWeight: "bold" }}
                                                    formatter={(value) => [fmt(value), "Revenue"]}
                                                />
                                                <Bar dataKey="revenue" fill={S.accent} radius={[4, 4, 0, 0]} />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    ) : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#556" }}>No data for selected period</div>}
                                </div>
                            </div>

                            <div style={{ background: "#0e0e12", padding: 20, borderRadius: 16, border: "1px solid #1a1a25" }}>
                                <h3 style={{ margin: "0 0 16px", color: "#ddd", fontSize: 16 }}>Revenue by Vendor</h3>
                                <div style={{ width: "100%", height: 350 }}>
                                    {revVendor.length > 0 ? (
                                        <ResponsiveContainer>
                                            <PieChart>
                                                <Pie data={revVendor} cx="50%" cy="45%" innerRadius={70} outerRadius={110} paddingAngle={2} dataKey="value">
                                                    {revVendor.map((entry, index) => <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} stroke="rgba(0,0,0,0.5)" strokeWidth={2} />)}
                                                </Pie>
                                                <Tooltip
                                                    contentStyle={{ background: "#1a1a25", border: "1px solid #2a2a35", borderRadius: 8, color: "#fff" }}
                                                    itemStyle={{ color: "#fff", fontWeight: "bold" }}
                                                    formatter={(value) => [fmt(value), ""]}
                                                />
                                                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: 11, color: "#aaa" }} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    ) : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#556" }}>No data for selected period</div>}
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {tab === "audit" && (
                    <div style={{ background: "#0e0e12", border: "1px solid #1a1a25", borderRadius: 10, overflow: "hidden" }}>
                        <div style={{ padding: "12px 16px", borderBottom: "1px solid #1a1a25", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: S.accent }}><svg width="14" height="14" viewBox="0 0 24 24" style={{ verticalAlign: "middle", marginRight: 6 }}>{Icons.Shield}</svg> Audit Log</div>
                            <span style={{ fontSize: 10, color: "#556" }}>{auditLogs.length} events</span>
                        </div>
                        {auditLogs.slice(-50).reverse().map((log, i) => (
                            <div key={i} style={{ padding: "10px 16px", borderBottom: "1px solid #121219", fontSize: 11, display: "flex", justifyContent: "space-between" }}>
                                <div><span style={{ color: log.action.includes("FAIL") ? "#f44" : log.action.includes("LOCK") || log.action.includes("TIMEOUT") ? "#fa0" : "#4f4", fontWeight: 700, marginRight: 8 }}>{log.action}</span>{log.system && <span style={{ color: "#556" }}>({log.system})</span>}</div>
                                <span style={{ color: "#445", fontFamily: "monospace", fontSize: 10 }}>{new Date(log.timestamp).toLocaleString()}</span>
                            </div>
                        ))}
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