import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";

export function StackBundleDialog({
  dealIds,
  headers,
  onClose,
  onSaved,
}: {
  dealIds: string[];
  headers: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("Pickup bundle");
  const [mode, setMode] = useState<"pickup" | "ship">("pickup");
  const [error, setError] = useState("");

  async function save() {
    setError("");
    try {
      await apiRequest("POST", "/api/priority-stack/bundles", { label: label.trim(), mode, dealIds }, { headers });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, "") : "Could not bundle those orders");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" data-testid="dialog-bundle">
      <form
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-background p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="text-base font-semibold">Bundle {dealIds.length} orders</h2>
        <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={label} onChange={(event) => setLabel(event.target.value)} data-testid="input-bundle-label" required />
        <div className="flex gap-2">
          <Button type="button" size="sm" variant={mode === "pickup" ? "default" : "outline"} onClick={() => setMode("pickup")}>Pickup</Button>
          <Button type="button" size="sm" variant={mode === "ship" ? "default" : "outline"} onClick={() => setMode("ship")}>Ship</Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" data-testid="button-save-bundle">Bundle</Button>
        </div>
      </form>
    </div>
  );
}
