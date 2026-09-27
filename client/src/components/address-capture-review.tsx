import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CUSTOMER_ADDRESS_CHECK_NOTE, formatLabelAddress, type CaptureCheck } from "@shared/address-capture";
import { CLIENT_ADDRESS_ACK_TEXT } from "@shared/address-capture";
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
  acknowledgment,
}: {
  check: CaptureCheck;
  onUseSuggestion: () => void;
  onKeepTyped: () => void;
  acknowledgment?: { checked: boolean; onCheckedChange: (checked: boolean) => void };
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
      {acknowledgment ? (
        <label className="flex cursor-pointer items-start gap-3" data-testid="control-client-address-ack">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={acknowledgment.checked}
            onChange={(event) => acknowledgment.onCheckedChange(event.target.checked)}
            data-testid="checkbox-client-address-ack"
          />
          <span className="text-sm">{CLIENT_ADDRESS_ACK_TEXT}</span>
        </label>
      ) : null}
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
      <p className="text-sm text-muted-foreground">{CUSTOMER_ADDRESS_CHECK_NOTE}</p>
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

export type RawHubSpotAddress = {
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
};

function rawAddressText(raw: RawHubSpotAddress): string {
  const region = [raw.state, raw.zip].filter(Boolean).join(" ");
  const cityLine = [raw.city, region].filter(Boolean).join(", ");
  return [raw.address, cityLine, raw.country].filter(Boolean).join("\n");
}

export function ReplaceHubSpotCard({
  current,
  next,
  pending,
  onReplace,
  onKeep,
}: {
  current: RawHubSpotAddress;
  next: ShipAddressFields;
  pending?: boolean;
  onReplace: () => void;
  onKeep?: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3" data-testid="panel-replace-hubspot">
      <p className="text-sm font-semibold">Replace HubSpot address</p>
      <p className="text-sm text-muted-foreground">
        This contact already has an address. Nothing is written until you confirm this replacement.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-background p-3" data-testid="card-hubspot-current">
          <p className="text-xs text-muted-foreground">Current HubSpot address</p>
          <p className="mt-1 whitespace-pre-line text-sm">{rawAddressText(current)}</p>
        </div>
        <div className="rounded-md border border-border bg-background p-3" data-testid="card-hubspot-next">
          <p className="text-xs text-muted-foreground">New address</p>
          <p className="mt-1 whitespace-pre-line text-sm">{formatLabelAddress(next)}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          className="w-full"
          disabled={pending}
          onClick={onReplace}
          data-testid="button-replace-hubspot-address"
        >
          Replace HubSpot address
        </Button>
        {onKeep ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={onKeep}
            data-testid="button-keep-order-address"
          >
            Keep on this order
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SwitchToShipCard({ pending, onSwitch }: { pending?: boolean; onSwitch: () => void }) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3" data-testid="panel-switch-to-ship">
      <p className="text-sm font-semibold">This order is pickup</p>
      <p className="text-sm text-muted-foreground">
        Saving a shipping address will switch it to shipping. It stays pickup until you confirm.
      </p>
      <Button type="button" className="w-full" disabled={pending} onClick={onSwitch} data-testid="button-switch-to-ship">
        Switch to shipping
      </Button>
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
  identity,
  acknowledgment,
}: {
  fields: ShipAddressFields;
  note?: string;
  pending?: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  confirmLabel?: string;
  identity?: { name: string; email: string; phone: string };
  /** Required on the client form. Paste-to-fill leaves this off so the shop can save without it. */
  acknowledgment?: { checked: boolean; onCheckedChange: (checked: boolean) => void };
}) {
  const needsAck = Boolean(acknowledgment);
  return (
    <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="panel-label-confirm">
      <p className="text-sm font-semibold">This is exactly what will go on your shipping label</p>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {identity ? (
        <div className="text-sm" data-testid="text-label-identity">
          <p>{identity.name}</p>
          {identity.email ? <p>{identity.email}</p> : null}
          {identity.phone ? <p>{identity.phone}</p> : null}
        </div>
      ) : null}
      <p className="whitespace-pre-line text-sm" data-testid="text-label-address">
        {formatLabelAddress(fields)}
      </p>
      {acknowledgment ? (
        <label className="flex cursor-pointer items-start gap-3" data-testid="control-client-address-ack">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={acknowledgment.checked}
            onChange={(event) => acknowledgment.onCheckedChange(event.target.checked)}
            data-testid="checkbox-client-address-ack"
          />
          <span className="text-sm">{CLIENT_ADDRESS_ACK_TEXT}</span>
        </label>
      ) : null}
      <Button
        type="button"
        className="w-full"
        onClick={onConfirm}
        disabled={pending || (needsAck && !acknowledgment?.checked)}
        data-testid="button-confirm-label-address"
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onEdit} data-testid="button-edit-label-address">
        Edit address
      </Button>
    </div>
  );
}
