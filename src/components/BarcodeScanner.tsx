import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let cancelled = false;
    function handleResult(result: Result | undefined) {
      if (!result) return;
      const text = result.getText();
      if (text) {
        controlsRef.current?.stop();
        controlsRef.current = null;
        onScan(text);
      }
    }

    async function start() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((d) => d.kind === "videoinput");

        if (cameras.length === 0) {
          setError("No camera found on this device.");
          return;
        }

        const back = cameras.find((d) => {
          const label = d.label.toLowerCase();
          return label.includes("back") || label.includes("rear") || label.includes("environment");
        });
        if (cancelled || !videoRef.current) return;

        const controls = await reader.decodeFromVideoDevice(
          back?.deviceId ?? cameras[0].deviceId,
          videoRef.current,
          handleResult,
        );
        controlsRef.current = controls;
      } catch (err) {
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          setError("Camera permission denied. Please allow camera access in Settings.");
        } else {
          setError("Failed to start camera. Please try again.");
        }
      }
    }

    start();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [onScan]);
  return (
    <div className="scanner-overlay">
      <div className="scanner-container">
        <div className="scanner-header">
          <span>Scan Barcode</span>
          <button className="scanner-close" onClick={onClose}>✕</button>
        </div>

        <div className="scanner-viewfinder">
          {error ? (
            <div className="scanner-error">
              <p>{error}</p>
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="scanner-video" playsInline autoPlay muted />
              <div className="scanner-reticle" />
            </>
          )}
        </div>

        <p className="scanner-hint">Point camera at a barcode to scan</p>
      </div>
    </div>
  );
}