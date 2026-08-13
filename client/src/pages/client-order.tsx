import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { CheckCircle2, Clock3, Loader2, PackageCheck, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { Mark } from "@/components/shell";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { cn } from "@/lib/utils";
import type { ClientOrderView } from "@shared/schema";

interface LookupOk {
  ok: true;
  view: ClientOrderView;
}

type LookupState =
  | { kind: "loading" }
  | { kind: "ready"; view: ClientOrderView }
  | { kind: "closed" }
  | { kind: "invalid" };

const EMPTY = {
  clientFullName: "",
  clientUsername: "",
  clientEmail: "",
  clientPhone: "",
  shippingStreet: "",
  shippingCity: "",
  shippingState: "",
  shippingPostalCode: "",
  shippingCountry: "",
  confirmedItem: "",
  quantity: "1",
  clientNotes: "",
};

export default function ClientOrder() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";
  const [form, setForm] = useState({ ...EMPTY });
  const [shippingRequired, setShippingRequired] = useState(true);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  /** The token travels in the request body so it never lands in a server log. */
  const lookup = useQuery<LookupOk>({
    queryKey: ["client-order-lookup", token],
    retry: false,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/client-order/lookup", { token });
      return (await res.json()) as LookupOk;
    },
  });

  useEffect(() => {
    const previous = document.title;
    document.title = "Order form";
    return () => {
      document.title = previous;
    };
  }, []);

  // A different token in the same tab must never show the previous buyer's state.
  useEffect(() => {
    setForm({ ...EMPTY });
    setShippingRequired(true);
    setPaymentConfirmed(false);
    setError("");
    setSubmitted(false);
  }, [token]);

  useEffect(() => {
    const view = lookup.data?.view;
    if (!view) return;
    const saved = view.savedDetails;
    setForm((current) => {
      const next = { ...current };
      if (!next.confirmedItem && view.itemDescription) next.confirmedItem = view.itemDescription;
      if (saved) {
        if (!next.clientFullName) next.clientFullName = saved.clientFullName;
        if (!next.clientUsername) next.clientUsername = saved.clientUsername;
        if (!next.clientEmail) next.clientEmail = saved.clientEmail;
        if (!next.clientPhone) next.clientPhone = saved.clientPhone;
        if (!next.shippingStreet) next.shippingStreet = saved.shippingStreet;
        if (!next.shippingCity) next.shippingCity = saved.shippingCity;
        if (!next.shippingState) next.shippingState = saved.shippingState;
        if (!next.shippingPostalCode) next.shippingPostalCode = saved.shippingPostalCode;
        if (!next.shippingCountry) next.shippingCountry = saved.shippingCountry;
      }
      return next;
    });
    if (saved) setShippingRequired(saved.shippingRequired);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup.data]);

  const state: LookupState = lookup.isLoading
    ? { kind: "loading" }
    : lookup.data
      ? { kind: "ready", view: lookup.data.view }
      : lookup.error && /^410/.test(lookup.error.message)
        ? { kind: "closed" }
        : { kind: "invalid" };

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/client-order/submit", {
        token,
        ...form,
        quantity: Number(form.quantity) || 1,
        shippingRequired,
        clientPaymentConfirmed: paymentConfirmed,
      });
      return (await res.json()) as { ok: true };
    },
    onSuccess: () => setSubmitted(true),
    onError: (mutationError: Error) => {
      const message = mutationError.message;
      const detail = message.match(/"error":"([^"]+)"/)?.[1];
      setError(
        /^410/.test(message)
          ? "This link has already been used or has expired. Please message the seller for a new one."
          : detail || "Something in the form needs another look. Please check the required fields.",
      );
    },
  });

  const set = (key: keyof typeof EMPTY, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const startSubmit = () => {
    setError("");
    if (form.clientFullName.trim().length < 2) return setError("Please enter your full name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.clientEmail.trim()))
      return setError("Please enter an email address the seller can reach you at.");
    if (form.confirmedItem.trim().length < 2) return setError("Please confirm what you ordered.");
    if (shippingRequired && form.shippingStreet.trim().length < 3)
      return setError("Please add the street address for delivery.");
    if (!paymentConfirmed)
      return setError("Please tick the box confirming you already paid the seller for this order.");
    submit.mutate();
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="accent-wash border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl items-center gap-2.5 px-5 py-4">
          <Mark className="h-7 w-7 text-primary" />
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">Print Orders</span>
            <span className="rule-label">Order form</span>
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-5 py-8 md:py-12">
        {state.kind === "loading" && (
          <div className="space-y-3" data-testid="skeleton-client-order">
            <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-40 animate-pulse rounded-lg bg-muted/70" />
          </div>
        )}

        {state.kind === "invalid" && (
          <Notice
            title="This link is not valid"
            body="Double-check the link the seller sent you, or message them for a new one."
            testId="text-client-invalid"
          />
        )}

        {state.kind === "closed" && (
          <Notice
            title="This link is closed"
            body="It has already been used or has expired. Message the seller and they can send you a fresh link."
            testId="text-client-closed"
          />
        )}

        {state.kind === "ready" && submitted && (
          <div
            className="rounded-lg border border-chart-4/40 bg-chart-4/10 p-6"
            data-testid="panel-client-submitted"
          >
            <CheckCircle2 className="h-6 w-6 text-chart-4" />
            <h1 className="mt-3 text-lg font-semibold tracking-tight">Thank you — details received</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The seller now has everything they need to set up your print. They will confirm the
              order with you directly in Marketplace. This link is now closed.
            </p>
          </div>
        )}

        {state.kind === "ready" && !submitted && (
          <>
            <h1 className="text-xl font-semibold tracking-tight" data-testid="text-client-heading">
              Your order details
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              This form only collects the details needed to prepare and send your print. It does not
              charge you, take any payment, and it does not place a final order yet — the seller
              confirms that with you after reviewing what you enter here.
            </p>

            {state.view.savedDetails && (
              <div
                className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
                data-testid="panel-saved-details"
              >
                <p className="text-sm font-medium">We filled this from your last order</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Please check your contact and shipping details are still right. Change anything
                  that has moved, then confirm you already paid for this order.
                </p>
              </div>
            )}

            <section
              className="mt-6 rounded-lg border border-border bg-card p-4"
              data-testid="panel-agreed-order"
            >
              <p className="rule-label">What you agreed with the seller</p>
              {(state.view.lineItems?.length ?? 0) > 1 ? (
                <ul className="mt-2 space-y-2" data-testid="list-agreed-line-items">
                  {state.view.lineItems.map((line, index) => (
                    <li key={`${line.description}-${index}`} className="text-sm">
                      <span className="font-medium">{line.description}</span>
                      {line.quantity > 1 ? (
                        <span className="text-muted-foreground"> · qty {line.quantity}</span>
                      ) : null}
                      <span className="numeric mt-0.5 block text-muted-foreground">${line.amount}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-sm font-medium" data-testid="text-agreed-item">
                  {state.view.itemDescription}
                </p>
              )}
              <p className="numeric mt-2 text-sm text-muted-foreground" data-testid="text-agreed-amount">
                Total amount paid: ${state.view.agreedAmount}
              </p>
              {(state.view.buyerNameHint || state.view.buyerUsernameHint) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Prepared for {state.view.buyerNameHint || state.view.buyerUsernameHint}
                </p>
              )}
            </section>

            <div className="mt-6 space-y-6">
              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold">How can the seller reach you?</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ClientField
                    id="client-full-name"
                    label="Full name"
                    value={form.clientFullName}
                    onChange={(v) => set("clientFullName", v)}
                    required
                    autoComplete="name"
                  />
                  <ClientField
                    id="client-username"
                    label="Marketplace username"
                    value={form.clientUsername}
                    onChange={(v) => set("clientUsername", v)}
                  />
                  <ClientField
                    id="client-email"
                    label="Email"
                    type="email"
                    value={form.clientEmail}
                    onChange={(v) => set("clientEmail", v)}
                    required
                    autoComplete="email"
                  />
                  <ClientField
                    id="client-phone"
                    label="Phone"
                    type="tel"
                    value={form.clientPhone}
                    onChange={(v) => set("clientPhone", v)}
                    autoComplete="tel"
                  />
                </div>
              </fieldset>

              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold">Where should it go?</legend>
                <div className="flex flex-wrap gap-2">
                  {[
                    { label: "Ship it to me", value: true },
                    { label: "I'll pick it up", value: false },
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => setShippingRequired(option.value)}
                      aria-pressed={shippingRequired === option.value}
                      data-testid={`button-shipping-${option.value ? "yes" : "no"}`}
                      className={cn(
                        "rounded-md border px-3 py-2 text-sm transition-colors",
                        shippingRequired === option.value
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {shippingRequired && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <AddressAutocomplete
                      street={form.shippingStreet}
                      onStreetChange={(v) => set("shippingStreet", v)}
                      onSelect={(address) => {
                        setForm((current) => ({
                          ...current,
                          shippingStreet: address.street,
                          shippingCity: address.city || current.shippingCity,
                          shippingState: address.state || current.shippingState,
                          shippingPostalCode: address.postalCode || current.shippingPostalCode,
                          shippingCountry: address.country || current.shippingCountry,
                        }));
                      }}
                    />
                    <ClientField
                      id="shipping-city"
                      label="City"
                      value={form.shippingCity}
                      onChange={(v) => set("shippingCity", v)}
                      autoComplete="address-level2"
                    />
                    <ClientField
                      id="shipping-state"
                      label="State / province"
                      value={form.shippingState}
                      onChange={(v) => set("shippingState", v)}
                      autoComplete="address-level1"
                    />
                    <ClientField
                      id="shipping-postal-code"
                      label="Postal code"
                      value={form.shippingPostalCode}
                      onChange={(v) => set("shippingPostalCode", v)}
                      autoComplete="postal-code"
                    />
                    <ClientField
                      id="shipping-country"
                      label="Country"
                      value={form.shippingCountry}
                      onChange={(v) => set("shippingCountry", v)}
                      autoComplete="country-name"
                    />
                  </div>
                )}
              </fieldset>

              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold">Confirm what you ordered</legend>
                <div className="space-y-1.5">
                  <Label htmlFor="confirmed-item">
                    {(state.view.lineItems?.length ?? 0) > 1 ? "Notes or corrections" : "Item or model"}
                    <span className="text-primary"> *</span>
                  </Label>
                  <Textarea
                    id="confirmed-item"
                    className="min-h-20 resize-y text-sm"
                    value={form.confirmedItem}
                    onChange={(event) => set("confirmedItem", event.target.value)}
                    data-testid="input-confirmed-item"
                  />
                  <p className="text-xs text-muted-foreground">
                    {(state.view.lineItems?.length ?? 0) > 1
                      ? "Confirm the list above looks right, or note anything the seller should double-check."
                      : "Pre-filled from your conversation. Edit it if anything looks wrong and the seller will check before confirming."}
                  </p>
                </div>
                {(state.view.lineItems?.length ?? 0) <= 1 ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ClientField
                      id="quantity"
                      label="Quantity"
                      value={form.quantity}
                      onChange={(v) => set("quantity", v)}
                      inputMode="numeric"
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor="client-notes">Notes or special instructions</Label>
                  <Textarea
                    id="client-notes"
                    className="min-h-20 resize-y text-sm"
                    value={form.clientNotes}
                    onChange={(event) => set("clientNotes", event.target.value)}
                    placeholder="Colour preference, deadline, gift packing, anything the seller should know"
                    data-testid="input-client-notes"
                  />
                </div>
              </fieldset>

              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3",
                  paymentConfirmed ? "border-primary/40 bg-primary/5" : "border-border bg-muted/20",
                )}
                data-testid="control-client-payment-confirm"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={paymentConfirmed}
                  onChange={(event) => setPaymentConfirmed(event.target.checked)}
                  data-testid="checkbox-client-payment-confirmed"
                />
                <span>
                  <span className="block text-sm font-medium">
                    I have already paid the seller for this order
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    This form does not take payment. It only records that payment was already made.
                  </span>
                </span>
              </label>

              {error && (
                <p
                  className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                  role="alert"
                  data-testid="text-client-error"
                >
                  {error}
                </p>
              )}

              <Button
                type="button"
                className="w-full"
                onClick={startSubmit}
                disabled={submit.isPending}
                data-testid="button-submit-client-details"
              >
                {submit.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <PackageCheck className="mr-2 h-4 w-4" />
                )}
                Send my details to the seller
              </Button>

              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  Your details go straight to the seller for this one order. The form can be
                  submitted once, and the link stops working afterwards.
                </p>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Notice({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6" data-testid={testId}>
      <Clock3 className="h-6 w-6 text-muted-foreground" />
      <h1 className="mt-3 text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function ClientField({
  id,
  label,
  value,
  onChange,
  required,
  type = "text",
  inputMode,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  inputMode?: "numeric" | "text" | "tel" | "email";
  autoComplete?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-primary"> *</span>}
      </Label>
      <Input
        id={id}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`input-${id}`}
      />
    </div>
  );
}
