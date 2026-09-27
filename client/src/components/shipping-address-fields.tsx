import { AddressAutocomplete, type AddressFill } from "@/components/address-autocomplete";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { countryIsUs, isUsZip, normalizeUsStateProvince, usStateOptions } from "@shared/ship-address";

export type ShippingFormAddress = {
  street: string;
  street2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

const FIELD_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm";

const STATES = usStateOptions();

function zipDraft(value: string, us: boolean): string {
  if (!us) return value;
  return value.replace(/[^\d-]/g, "").slice(0, 10);
}

export function shippingAddressError(value: ShippingFormAddress): string {
  if (value.street.trim().length < 3) return "Please add the street address for delivery.";
  if (value.city.trim().length < 2) return "Please add the city.";
  if (countryIsUs(value.country)) {
    const state = normalizeUsStateProvince(value.state);
    if (!STATES.some((option) => option.code === state)) return "Please choose a state.";
    if (!isUsZip(value.postalCode)) return "Please enter a 5-digit ZIP, or ZIP+4.";
  } else {
    if (value.state.trim().length < 2) return "Please add the state or province.";
    if (value.postalCode.trim().length < 3) return "Please add the postal code.";
  }
  if (value.country.trim().length < 2) return "Please add the country.";
  return "";
}

export function ShippingAddressFields({
  value,
  onChange,
  idPrefix = "shipping",
}: {
  value: ShippingFormAddress;
  onChange: (next: ShippingFormAddress) => void;
  idPrefix?: string;
}) {
  const us = countryIsUs(value.country);
  const stateCode = us ? normalizeUsStateProvince(value.state) : value.state;
  const set = (patch: Partial<ShippingFormAddress>) => onChange({ ...value, ...patch });

  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="panel-shipping-address">
      <div className="sm:col-span-2">
        <AddressAutocomplete
          id={`${idPrefix}-street`}
          street={value.street}
          onStreetChange={(street) => set({ street })}
          onSelect={(address: AddressFill) =>
            onChange({
              ...value,
              street: address.street,
              city: address.city || value.city,
              state: address.state ? normalizeUsStateProvince(address.state) : value.state,
              postalCode: address.postalCode || value.postalCode,
              country: address.country ? (countryIsUs(address.country) ? "US" : address.country) : value.country || "US",
            })
          }
        />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-street-2`}>Apt/Unit</Label>
        <Input
          id={`${idPrefix}-street-2`}
          name="address-line2"
          autoComplete="address-line2"
          value={value.street2}
          onChange={(event) => set({ street2: event.target.value })}
          placeholder="Optional"
          data-testid="input-shipping-street-2"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-city`}>
          City
          <span className="text-primary"> *</span>
        </Label>
        <Input
          id={`${idPrefix}-city`}
          name="address-level2"
          autoComplete="address-level2"
          autoCapitalize="words"
          value={value.city}
          onChange={(event) => set({ city: event.target.value })}
          data-testid="input-shipping-city"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-state`}>
          State
          <span className="text-primary"> *</span>
        </Label>
        {us ? (
          <select
            id={`${idPrefix}-state`}
            name="address-level1"
            autoComplete="address-level1"
            className={FIELD_CLASS}
            value={STATES.some((option) => option.code === stateCode) ? stateCode : ""}
            onChange={(event) => set({ state: event.target.value })}
            data-testid="input-shipping-state"
          >
            <option value="">Select state</option>
            {STATES.map((option) => (
              <option key={option.code} value={option.code}>
                {option.code} — {option.name}
              </option>
            ))}
          </select>
        ) : (
          <Input
            id={`${idPrefix}-state`}
            name="address-level1"
            autoComplete="address-level1"
            value={value.state}
            onChange={(event) => set({ state: event.target.value })}
            data-testid="input-shipping-state"
          />
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-postal-code`}>
          ZIP
          <span className="text-primary"> *</span>
        </Label>
        <Input
          id={`${idPrefix}-postal-code`}
          name="postal-code"
          autoComplete="postal-code"
          inputMode={us ? "numeric" : "text"}
          autoCapitalize="off"
          maxLength={us ? 10 : 12}
          placeholder={us ? "12345 or 12345-6789" : ""}
          value={value.postalCode}
          onChange={(event) => set({ postalCode: zipDraft(event.target.value, us) })}
          data-testid="input-shipping-postal-code"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-country`}>
          Country
          <span className="text-primary"> *</span>
        </Label>
        <Input
          id={`${idPrefix}-country`}
          name="country"
          autoComplete="country"
          autoCapitalize="characters"
          value={value.country}
          onChange={(event) => set({ country: event.target.value })}
          data-testid="input-shipping-country"
        />
      </div>
    </div>
  );
}
