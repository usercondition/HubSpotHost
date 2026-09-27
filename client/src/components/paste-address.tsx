import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { DidYouMeanCard, LabelConfirmCard } from "@/components/address-capture-review";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import type { CaptureCheck } from "@shared/address-capture";
import type { ShipAddressFields } from "@shared/ship-address";

type Preview = CaptureCheck & {
  formattedTyped?: string;
  formattedSuggestion?: string;
};

function readPreview(payload: Record<string, unknown>): Preview | null {
  const typed = payload.typed;
  if (!typed || typeof typed !== "object") return null;
  const suggestion = payload.suggestion && typeof payload.suggestion === "object" ? (payload.suggestion as ShipAddressFields) : null;
  const messages = Array.isArray(payload.messages) ? payload.messages.filter((item) => typeof item === "string") : [];
  const status = payload.status;
  return {
    status:
      status === "verified" || status === "corrected" || status === "unverified" || status === "unchecked" || status === "error"
        ? status
        : "unchecked",
    needsUnit: payload.needsUnit === true,
    typed: typed as ShipAddressFields,
    suggestion,
    messages,
  };
}

/**
 * Owner paste box. Parsing and ShipEngine run on Check.
 * Nothing is saved until the result is confirmed.
 */
export function PasteAddressBox({
  headers,
  onApply,
  applyLabel = "Use this address",
}: {
  headers?: Record<string, string>;
  onApply: (fields: ShipAddressFields, decision: "accept" | "override" | "confirm", noUnit: boolean) => Promise<void> | void;
  applyLabel?: string;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [chosen, setChosen] = useState<ShipAddressFields | null>(null);
  const [decision, setDecision] = useState<"accept" | "override" | "confirm">("confirm");
  const [noUnit, setNoUnit] = useState(false);
  const [phase, setPhase] = useState<"paste" | "choice" | "confirm">("paste");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const check = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/address-capture/preview", { text }, { headers });
      return (await response.json()) as Record<string, unknown>;
    },
    onSuccess: (payload) => {
      const next = readPreview(payload);
      if (!next) {
        setError("That paste could not be read as an address.");
        return;
      }
      setPreview(next);
      setSaved("");
      setNoUnit(false);
      if (next.status === "corrected" && next.suggestion) {
        setPhase("choice");
        setChosen(null);
        return;
      }
      setChosen(next.typed);
      setDecision("confirm");
      setPhase("confirm");
    },
    onError: (mutationError: Error) => {
      const detail = mutationError.message.match(/"error":"([^"]+)"/)?.[1];
      setError(detail || "The address could not be checked.");
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!chosen) throw new Error("Confirm the address first.");
      await onApply(chosen, decision, noUnit);
    },
    onSuccess: () => {
      setSaved("Address confirmed.");
      setPhase("paste");
      setText("");
      setPreview(null);
      setChosen(null);
    },
    onError: (mutationError: Error) => {
      const detail = mutationError.message.match(/"error":"([^"]+)"/)?.[1];
      setError(detail || "The address was not saved.");
    },
  });

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3" data-testid="panel-paste-address">
      <div className="space-y-1.5">
        <Label htmlFor="paste-address">Paste address</Label>
        <Textarea
          id="paste-address"
          className="min-h-24 resize-y text-sm"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSaved("");
          }}
          placeholder="Paste a full address from Marketplace or Messenger"
          data-testid="input-paste-address"
        />
      </div>
      {phase === "paste" ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setError("");
            check.mutate();
          }}
          disabled={check.isPending || text.trim().length < 5}
          data-testid="button-check-pasted-address"
        >
          {check.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Check address
        </Button>
      ) : null}
      {phase === "choice" && preview ? (
        <DidYouMeanCard
          check={preview}
          onUseSuggestion={() => {
            if (!preview.suggestion) return;
            setChosen(preview.suggestion);
            setDecision("accept");
            setPhase("confirm");
          }}
          onKeepTyped={() => {
            setChosen(preview.typed);
            setDecision("override");
            setPhase("confirm");
          }}
        />
      ) : null}
      {phase === "confirm" && chosen ? (
        <LabelConfirmCard
          fields={chosen}
          note={
            preview?.status === "unverified" || preview?.status === "error"
              ? "This address was not verified. It will be flagged for you."
              : preview?.status === "unchecked"
                ? "ShipEngine could not check this address just now. It will be flagged for you."
                : undefined
          }
          pending={save.isPending}
          confirmLabel={applyLabel}
          onConfirm={() => {
            setError("");
            save.mutate();
          }}
          onEdit={() => {
            setPhase("paste");
            setChosen(null);
          }}
        />
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="text-paste-address-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-muted-foreground" data-testid="text-paste-address-saved">
          {saved}
        </p>
      ) : null}
    </div>
  );
}
