import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatLabelAddress, type CaptureCheck } from "@shared/address-capture";
import type { ShipAddressFields } from "@shared/ship-address";

function AddressBlock({ label, fields, testId }: { label: string; fields: ShipAddressFields; testId: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 whitespace-pre-line text-sm">{formatLabelAddress(fields)}</p>
    </div>
  );
}

export function DidYouMeanCard({
  check,
  onUseSuggestion,
  onKeepTyped,
}: {
  check: CaptureCheck;
  onUseSuggestion: () => void;
  onKeepTyped: () => void;
}) {
  if (!check.suggestion) return null;
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3" data-testid="panel-did-you-mean">
      <p className="text-sm font-semibold">Did you mean</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <AddressBlock label="What you typed" fields={check.typed} testId="card-address-typed" />
          <Button type="button" variant="outline" className="w-full" onClick={onKeepTyped} data-testid="button-keep-typed-address">
            Keep what I typed
          </Button>
        </div>
        <div className="space-y-2">
          <AddressBlock label="Standardized address" fields={check.suggestion} testId="card-address-standardized" />
          <Button type="button" className="w-full" onClick={onUseSuggestion} data-testid="button-use-standardized-address">
            Use this address
          </Button>
        </div>
      </div>
    </div>
  );
}

export function UnverifiedAddressCard({
  fields,
  onConfirmCheck,
}: {
  fields: ShipAddressFields;
  onConfirmCheck: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3" data-testid="panel-address-unverified">
      <p className="text-sm font-semibold">Please double-check this address</p>
      <p className="text-sm text-muted-foreground">
        We could not verify it, so it is flagged for Miguel before a label is printed.
      </p>
      <AddressBlock label="Address to check" fields={fields} testId="card-address-unverified" />
      <Button type="button" className="w-full" onClick={onConfirmCheck} data-testid="button-address-double-check">
        I double-checked it
      </Button>
    </div>
  );
}

export function UnitPrompt({
  unit,
  onUnitChange,
  onRecheck,
  onNoUnit,
}: {
  unit: string;
  onUnitChange: (value: string) => void;
  onRecheck: () => void;
  onNoUnit: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3" data-testid="panel-address-unit">
      <p className="text-sm font-semibold">This building needs an Apt/Unit</p>
      <p className="text-sm text-muted-foreground">
        The address looks like it has more than one unit. Add the apartment or unit so it can go on the label.
      </p>
      <Input
        name="address-line2"
        autoComplete="address-line2"
        value={unit}
        onChange={(event) => onUnitChange(event.target.value)}
        placeholder="Apt/Unit"
        data-testid="input-address-unit-prompt"
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" className="flex-1" onClick={onRecheck} data-testid="button-recheck-unit">
          Check again
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={onNoUnit} data-testid="button-address-no-unit">
          This address has no unit
        </Button>
      </div>
    </div>
  );
}

export function LabelConfirmCard({
  fields,
  note,
  pending,
  onConfirm,
  onEdit,
  confirmLabel = "Yes, this address is correct",
}: {
  fields: ShipAddressFields;
  note?: string;
  pending?: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  confirmLabel?: string;
}) {
  return (
    <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="panel-label-confirm">
      <p className="text-sm font-semibold">This is exactly what will go on your shipping label</p>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      <p className="whitespace-pre-line text-sm" data-testid="text-label-address">
        {formatLabelAddress(fields)}
      </p>
      <Button type="button" className="w-full" onClick={onConfirm} disabled={pending} data-testid="button-confirm-label-address">
        {confirmLabel}
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onEdit} data-testid="button-edit-label-address">
        Edit address
      </Button>
    </div>
  );
}
