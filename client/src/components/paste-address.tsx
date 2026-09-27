import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  DidYouMeanCard,
  LabelConfirmCard,
  ReplaceHubSpotCard,
  SwitchToShipCard,
  UnitPrompt,
  type RawHubSpotAddress,
} from "@/components/address-capture-review";
import { ShippingAddressFields, type ShippingFormAddress } from "@/components/shipping-address-fields";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { HUBSPOT_WRITES_OFF_MESSAGE, type CaptureCheck } from "@shared/address-capture";
import type { ShipAddressFields } from "@shared/ship-address";

type Preview = CaptureCheck & {
  formattedTyped?: string;
  formattedSuggestion?: string;
};

type ApplyResult = {
  wrote?: boolean;
  writesOff?: boolean;
  message?: string;
  offbookId?: number;
};

type ApplyOptions = {
  replaceHubspot?: boolean;
  switchToShip?: boolean;
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

function readRaw(value: unknown): RawHubSpotAddress | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const text = (key: string) => (typeof row[key] === "string" ? row[key] : "");
  return {
    address: text("address"),
    city: text("city"),
    state: text("state"),
    zip: text("zip"),
    country: text("country"),
  };
}

function fieldsToForm(fields: ShipAddressFields): ShippingFormAddress {
  return {
    street: fields.street1,
    street2: fields.street2,
    city: fields.city,
    state: fields.state,
    postalCode: fields.zip,
    country: fields.country || "US",
  };
}

function formToFields(value: ShippingFormAddress): ShipAddressFields {
  return {
    street1: value.street,
    street2: value.street2,
    city: value.city,
    state: value.state,
    zip: value.postalCode,
    country: value.country || "US",
  };
}

function payloadFromError(error: Error): Record<string, unknown> | null {
  const raw = error.message.replace(/^\d+:\s*/, "");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Owner paste box. Parsing and the address check run on Check.
 * Nothing is saved until the result is confirmed.
 */
export function PasteAddressBox({
  headers,
  onApply,
  applyLabel = "Use this address",
}: {
  headers?: Record<string, string>;
  onApply: (
    fields: ShipAddressFields,
    decision: "accept" | "override" | "confirm",
    noUnit: boolean,
    options?: ApplyOptions,
  ) => Promise<ApplyResult | void> | ApplyResult | void;
  applyLabel?: string;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [chosen, setChosen] = useState<ShipAddressFields | null>(null);
  const [decision, setDecision] = useState<"accept" | "override" | "confirm">("confirm");
  const [noUnit, setNoUnit] = useState(false);
  const [replaceHubspot, setReplaceHubspot] = useState(false);
  const [switchToShip, setSwitchToShip] = useState(false);
  const [currentHubspot, setCurrentHubspot] = useState<RawHubSpotAddress | null>(null);
  const [phase, setPhase] = useState<"paste" | "unit" | "choice" | "confirm" | "replace" | "switch">("paste");
  const [unitDraft, setUnitDraft] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const showAfterCheck = (next: Preview, fields: ShipAddressFields, skipUnit = false) => {
    setPreview(next);
    setChosen(fields);
    if (next.needsUnit && !fields.street2.trim() && !skipUnit) {
      setUnitDraft(fields.street2);
      setPhase("unit");
      return;
    }
    if (next.status === "corrected" && next.suggestion) {
      setPhase("choice");
      setChosen(null);
      return;
    }
    setDecision("confirm");
    setPhase("confirm");
  };

  const check = useMutation({
    mutationFn: async (value: string) => {
      const response = await apiRequest("POST", "/api/address-capture/preview", { text: value }, { headers });
      return (await response.json()) as Record<string, unknown>;
    },
    onSuccess: (payload) => {
      const next = readPreview(payload);
      if (!next) {
        setError("That paste could not be read as an address.");
        return;
      }
      setSaved("");
      setNoUnit(false);
      setReplaceHubspot(false);
      setSwitchToShip(false);
      showAfterCheck(next, next.typed);
    },
    onError: (mutationError: Error) => {
      const detail = mutationError.message.match(/"error":"([^"]+)"/)?.[1];
      setError(detail || "The address could not be checked.");
    },
  });

  const save = useMutation({
    mutationFn: async (options?: ApplyOptions) => {
      if (!chosen) throw new Error("Confirm the address first.");
      return onApply(chosen, decision, noUnit, {
        replaceHubspot: options?.replaceHubspot ?? replaceHubspot,
        switchToShip: options?.switchToShip ?? switchToShip,
      });
    },
    onSuccess: (result) => {
      if (result && result.writesOff) {
        setSaved(result.message || HUBSPOT_WRITES_OFF_MESSAGE);
      } else if (result && result.wrote === false && result.offbookId) {
        setSaved("Address saved on this order.");
      } else {
        setSaved("Address saved.");
      }
      setPhase("paste");
      setText("");
      setPreview(null);
      setChosen(null);
      setNoUnit(false);
      setReplaceHubspot(false);
      setSwitchToShip(false);
    },
    onError: (mutationError: Error) => {
      const payload = payloadFromError(mutationError);
      const code = typeof payload?.code === "string" ? payload.code : "";
      if (code === "needs_unit") {
        const next = payload ? readPreview(payload) : null;
        if (next) setPreview(next);
        setUnitDraft(chosen?.street2 ?? "");
        setPhase("unit");
        setError("");
        return;
      }
      if (code === "address_choice") {
        const next = payload ? readPreview(payload) : null;
        if (next) {
          setPreview(next);
          setPhase("choice");
          setChosen(null);
          setError("");
          return;
        }
      }
      if (code === "replace_hubspot") {
        const current = readRaw(payload?.current);
        const nextFields = payload?.next && typeof payload.next === "object" ? (payload.next as ShipAddressFields) : chosen;
        if (current && nextFields) {
          setCurrentHubspot(current);
          setChosen(nextFields);
          setPhase("replace");
          setError("");
          return;
        }
      }
      if (code === "switch_to_ship") {
        setPhase("switch");
        setError("");
        return;
      }
      const detail = mutationError.message.match(/"error":"([^"]+)"/)?.[1];
      setError(detail || "The address was not saved.");
    },
  });

  const confirmNote =
    preview?.status === "error"
      ? "This address check returned an error. It will be flagged for you."
      : preview?.status === "unverified"
        ? "This address was not verified. It will be flagged for you."
        : preview?.status === "unchecked"
          ? "The address could not be checked just now. It will be flagged for you."
          : undefined;

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
            setNoUnit(false);
          }}
          placeholder="Paste a full address from Marketplace or Messenger"
          data-testid="input-paste-address"
        />
      </div>
      {preview ? (
        <ShippingAddressFields
          idPrefix="paste"
          value={fieldsToForm(chosen ?? preview.typed)}
          onChange={(next) => {
            setChosen(formToFields(next));
            setDecision("confirm");
            setSaved("");
          }}
        />
      ) : null}
      {phase === "paste" ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setError("");
            check.mutate(text);
          }}
          disabled={check.isPending || text.trim().length < 5}
          data-testid="button-check-pasted-address"
        >
          {check.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Check address
        </Button>
      ) : null}
      {phase === "unit" && preview ? (
        <UnitPrompt
          unit={unitDraft}
          onUnitChange={(value) => {
            setUnitDraft(value);
            setNoUnit(false);
          }}
          onRecheck={() => {
            const nextText = unitDraft.trim() ? `${text}\n${unitDraft.trim()}` : text;
            setText(nextText);
            setNoUnit(false);
            setError("");
            check.mutate(nextText);
          }}
          onNoUnit={() => {
            setNoUnit(true);
            if (!preview) return;
            if (preview.status === "corrected" && preview.suggestion) {
              setPhase("choice");
              setChosen(null);
              return;
            }
            setChosen(preview.typed);
            setDecision("confirm");
            setPhase("confirm");
          }}
        />
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
          note={confirmNote}
          pending={save.isPending}
          confirmLabel={applyLabel}
          onConfirm={() => {
            setError("");
            save.mutate(undefined);
          }}
          onEdit={() => {
            setPhase("paste");
            setChosen(null);
            setNoUnit(false);
          }}
        />
      ) : null}
      {phase === "replace" && currentHubspot && chosen ? (
        <ReplaceHubSpotCard
          current={currentHubspot}
          next={chosen}
          pending={save.isPending}
          onReplace={() => {
            setReplaceHubspot(true);
            setError("");
            save.mutate({ replaceHubspot: true, switchToShip });
          }}
        />
      ) : null}
      {phase === "switch" ? (
        <SwitchToShipCard
          pending={save.isPending}
          onSwitch={() => {
            setSwitchToShip(true);
            setError("");
            save.mutate({ replaceHubspot, switchToShip: true });
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
