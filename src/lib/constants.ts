export const ROUTES = {
  PRODUCTS: "/products",
  ADD: "/add",
  PATIENTS: "/patients",
  MIMEDX: "/mimedx",
  COMMISSION: "/commission",
  PRICES: "/prices",
  VENDORS: "/vendors",
  SUMMARY: "/summary",
  AUDIT: "/audit",
} as const;

export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
export const SESSION_CHECK_INTERVAL_MS = 10_000;

export const BARCODE_FORMATS = ["QR_CODE", "CODE_128", "EAN_13", "UPC_A"] as const;

export const APP = {
  NAME: "Product Tracker",
  VERSION: "1.0.0",
  BUNDLE_ID: "com.weekthink.producttracker",
} as const;