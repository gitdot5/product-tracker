import { useState } from "react";
import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { useEntryStore } from "@/store/useEntryStore";
import { useUIStore } from "@/store/useUIStore";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { ROUTES } from "@/lib/constants";

const entrySchema = z.object({
  system_id: z.string().min(1, "System ID is required"),
  facility: z.string().min(1, "Facility is required"),
  vendor: z.string().min(1, "Vendor is required"),
  date: z.string().min(1, "Date is required"),
  product_name: z.string().min(1, "Product name is required"),
  item_number: z.string().min(1, "Item number is required"),
  cost: z.coerce.number().min(0, "Cost must be positive"),
  patient: z.string().default(""),
});

type EntryFormData = z.infer<typeof entrySchema>;

export default function AddEntry() {
  const navigate = useNavigate();
  const add = useEntryStore((s) => s.add);
  const showToast = useUIStore((s) => s.showToast);
  const [scanning, setScanning] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<EntryFormData>({
    resolver: zodResolver(entrySchema) as any,
    defaultValues: {
      date: new Date().toISOString().split("T")[0],
      cost: 0,
      patient: "",
    },
  });

  function handleScan(value: string) {
    setValue("item_number", value, { shouldValidate: true });
    setScanning(false);
    showToast("success", `Scanned: ${value}`);
  }

  const onSubmit: SubmitHandler<EntryFormData> = async (data) => {
    try {
      const entry = await add(data);
      showToast("success", `${entry.product_name} added`);
      navigate(ROUTES.PRODUCTS);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save";
      showToast("error", message);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Add Entry</h1>
      </header>

      {scanning && (
        <BarcodeScanner
          onScan={handleScan}
          onClose={() => setScanning(false)}
        />
      )}

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="system_id">System ID *</label>
            <input
              id="system_id"
              className={`input ${errors.system_id ? "input-error" : ""}`}
              placeholder="e.g. SYS-001"
              {...register("system_id")}
            />
            {errors.system_id && <p className="form-error">{errors.system_id.message}</p>}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="facility">Facility *</label>
            <input
              id="facility"
              className={`input ${errors.facility ? "input-error" : ""}`}
              placeholder="e.g. Main Hospital"
              {...register("facility")}
            />
            {errors.facility && <p className="form-error">{errors.facility.message}</p>}
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="product_name">Product Name *</label>
            <input
              id="product_name"
              className={`input ${errors.product_name ? "input-error" : ""}`}
              placeholder="e.g. AmnioFix 2x3"
              {...register("product_name")}
            />
            {errors.product_name && <p className="form-error">{errors.product_name.message}</p>}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="item_number">Item Number *</label>
            <div className="input-with-action">
              <input
                id="item_number"
                className={`input ${errors.item_number ? "input-error" : ""}`}
                placeholder="e.g. AF-2X3-001"
                {...register("item_number")}
              />
              <button type="button" className="btn-scan" onClick={() => setScanning(true)}>
                Scan
              </button>
            </div>
            {errors.item_number && <p className="form-error">{errors.item_number.message}</p>}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="vendor">Vendor *</label>
          <input
            id="vendor"
            className={`input ${errors.vendor ? "input-error" : ""}`}
            placeholder="e.g. MiMedx"
            {...register("vendor")}
          />
          {errors.vendor && <p className="form-error">{errors.vendor.message}</p>}
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="date">Date *</label>
            <input
              id="date"
              type="date"
              className={`input ${errors.date ? "input-error" : ""}`}
              {...register("date")}
            />
            {errors.date && <p className="form-error">{errors.date.message}</p>}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="cost">Cost ($) *</label>
            <input id="cost" type="number" step="0.01" min="0" className="input" {...register("cost")} />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="patient">Patient</label>
          <input id="patient" className="input" placeholder="Patient name (optional)" {...register("patient")} />
        </div>

        <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Add Entry"}
        </button>
      </form>
    </div>
  );
}
