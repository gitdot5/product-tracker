import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import type { Result } from "@zxing/library";

interface BarcodeScannerProps {
  onScan: (value: string) => void;
  onClose: () => void;
}

export function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopScanning = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
  }, []);

  const handleResult = useCallback((result: Result | undefined) => {
    if (result) {
      const text = result.getText();
      if (text) { stopScanning(); onScan(text); }
    }
  }, [onScan, stopScanning]);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    const startScanning = async () => {      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter((d) => d.kind === "videoinput");
        if (videoDevices.length === 0) { setError("No camera found on this device."); return; }
        const backCamera = videoDevices.find((d: MediaDeviceInfo) =>
          d.label.toLowerCase().includes("back") || d.label.toLowerCase().includes("rear") || d.label.toLowerCase().includes("environment"));
        const deviceId = backCamera?.deviceId ?? videoDevices[0].deviceId;
        if (!videoRef.current) return;
        const controls = await reader.decodeFromVideoDevice(deviceId, videoRef.current, handleResult);
        controlsRef.current = controls;
      } catch (err) {
        const message = err instanceof DOMException && err.name === "NotAllowedError"
          ? "Camera permission denied. Please allow camera access in Settings."
          : "Failed to start camera. Please try again.";
        setError(message);
        console.error("[BarcodeScanner]", err);
      }
    };
    startScanning();
    return () => { stopScanning(); };
  }, [handleResult, stopScanning]);

  return (
    <div className="scanner-overlay">
      <div className="scanner-container">
        <div className="scanner-header">
          <span>Scan Barcode</span>
          <button className="scanner-close" onClick={onClose} aria-label="Close scanner">✕</button>
        </div>
        <div className="scanner-viewfinder">          {error ? (
            <div className="scanner-error">
              <p>{error}</p>
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="scanner-video" playsInline autoPlay muted />
              <div className="scanner-reticle" aria-hidden />
            </>
          )}
        </div>
        <p className="scanner-hint">Point camera at a barcode to scan</p>
      </div>
    </div>
  );
}