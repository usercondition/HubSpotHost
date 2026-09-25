import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";

export function OffbookEntryDialog({
  headers,
  onClose,
  onSaved,
}: {
  headers: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [contactName, setContactName] = useState("");
  const [mode, setMode] = useState<"pickup" | "ship">("pickup");
  const [targetDate, setTargetDate] = useState("");
  const [amount, setAmount] = useState("");
  const [blocker, setBlocker] = useState("");
  const [error, setError] = useState("");

  async function save() {
    setError("");
    try {
      await apiRequest(
        "POST",
        "/api/priority-stack/offbook",
        {
          title: title.trim(),
          contactName: contactName.trim(),
          mode,
          targetDate: targetDate || null,
          amount: amount.trim(),
          blocker: blocker.trim(),
        },
        { headers },
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, "") : "Could not add that order");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" data-testid="dialog-offbook">
      <form
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-background p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="text-base font-semibold">Off-book order</h2>
        <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" placeholder="What is it" value={title} onChange={(event) => setTitle(event.target.value)} data-testid="input-offbook-title" required />
        <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" placeholder="Who" value={contactName} onChange={(event) => setContactName(event.target.value)} data-testid="input-offbook-who" />
        <div className="flex gap-2">
          <Button type="button" size="sm" variant={mode === "pickup" ? "default" : "outline"} onClick={() => setMode("pickup")}>Pickup</Button>
          <Button type="button" size="sm" variant={mode === "ship" ? "default" : "outline"} onClick={() => setMode("ship")}>Ship</Button>
        </div>
        <input type="date" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} data-testid="input-offbook-date" />
        <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" placeholder="Amount (optional)" value={amount} onChange={(event) => setAmount(event.target.value)} data-testid="input-offbook-amount" />
        <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" placeholder="Blocker" value={blocker} onChange={(event) => setBlocker(event.target.value)} data-testid="input-offbook-blocker" />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" data-testid="button-save-offbook">Add</Button>
        </div>
      </form>
    </div>
  );
}
