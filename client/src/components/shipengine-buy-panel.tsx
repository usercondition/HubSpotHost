import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Loader2, Ship, AlertTriangle, ExternalLink, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Panel, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { queueDealHref } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import type { ProductionQueueResponse } from "@shared/schema";

/** Pull a readable message out of `400: {"ok":false,"error":"..."}` API failures. */
function formatShipEngineClientError(raw: string): string {
  const withoutStatus = raw.replace(/^\d+:\s*/, "").trim();
  try {
    const parsed = JSON.parse(withoutStatus) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim().slice(0, 240);
    }
  } catch {
    // not JSON
  }
  return withoutStatus.slice(0, 240);
}

type ShipEngineStatus = {
  ok: true;
  configured: boolean;
  hasApiKey: boolean;
  hasShipFrom: boolean;
  hasShipFromPhone?: boolean;
  testMode: boolean | null;
  shipFrom: {
    name: string;
    street1: string;
    street2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    hasPhone?: boolean;
  } | null;
  carriers?: Array<{ carrierId: string; carrierCode: string; friendlyName: string }>;
  carriersError?: string | null;
};

type ShipToResponse = {
  ok: true;
  dealId: string;
  ready: boolean;
  hasContact?: boolean;
  missing: string[];
  contact: {
    id: string | null;
    name: string;
    email: string;
    phone: string;
    addressLines: string[];
  };
};

type ShipEngineRate = {
  rateId: string;
  amount: string;
  currency: string;
  carrierId: string;
  carrierCode: string;
  carrierFriendlyName: string;
  serviceCode: string;
  serviceType: string;
  deliveryDays: number | null;
  attributes: string[];
};

type RatesResponse = {
  ok: true;
  dealId: string;
  testMode: boolean;
  rates: ShipEngineRate[];
  messages: string[];
  addressTo: { name: string; street1: string; city: string; state: string; zip: string };
};

type PurchaseResponse = {
  ok: true;
  duplicate?: boolean;
  message?: string;
  attachedDealIds?: string[];
  contact?: { id: string | null; name: string; email: string };
  shipengine?: {
    trackingNumber: string;
    labelUrl: string | null;
    amount: string;
    carrierCode: string;
    serviceCode: string;
    testMode: boolean;
  };
};

const DEFAULT_PARCEL = {
  lengthIn: "8",
  widthIn: "6",
  heightIn: "4",
  weightOz: "16",
};

type Props = {
  headers: Record<string, string>;
  ownerCode: string;
  isUnlocked: boolean;
  prefillDealId: string;
  messageChannel: "marketplace" | "offerup";
  onPurchased: (result: {
    dealIds: string[];
    dealName: string;
    contactName: string | null;
    contactEmail: string | null;
    trackingNumber: string;
    service: string | null;
    carrier: string | null;
    labelUrl: string | null;
  }) => void;
};

export function ShipEngineBuyPanel({
  headers,
  ownerCode,
  isUnlocked,
  prefillDealId,
  messageChannel,
  onPurchased,
}: Props) {
  const { toast } = useToast();
  const [dealId, setDealId] = useState(
    prefillDealId && /^[0-9]{1,20}$/.test(prefillDealId) ? prefillDealId : "",
  );
  const [parcel, setParcel] = useState(DEFAULT_PARCEL);
  const [rates, setRates] = useState<ShipEngineRate[]>([]);
  const [testMode, setTestMode] = useState(false);
  const [selectedRateId, setSelectedRateId] = useState("");
  const [addressHint, setAddressHint] = useState("");

  useEffect(() => {
    if (prefillDealId && /^[0-9]{1,20}$/.test(prefillDealId)) {
      setDealId(prefillDealId);
      setRates([]);
      setSelectedRateId("");
    }
  }, [prefillDealId]);

  const statusQuery = useQuery<ShipEngineStatus>({
    queryKey: ["/api/shipping-labels/shipengine/status", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        "/api/shipping-labels/shipengine/status",
        undefined,
        { headers },
      );
      return response.json();
    },
  });

  const queueQuery = useQuery<{ ok: true } & ProductionQueueResponse>({
    queryKey: ["/api/production-queue", ownerCode, "shipengine"],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/production-queue", undefined, { headers });
      return response.json();
    },
  });

  const shipToQuery = useQuery<ShipToResponse>({
    queryKey: ["/api/shipping-labels/ship-to", dealId, ownerCode],
    enabled: isUnlocked && /^[0-9]{1,20}$/.test(dealId),
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/shipping-labels/ship-to/${encodeURIComponent(dealId)}`,
        undefined,
        { headers },
      );
      return response.json();
    },
  });

  const shipReadyPicks = useMemo(() => {
    const items = [...(queueQuery.data?.shipReady ?? []), ...(queueQuery.data?.inProduction ?? [])];
    return items.slice(0, 8);
  }, [queueQuery.data]);

  const selectedRate = rates.find((rate) => rate.rateId === selectedRateId) ?? null;

  const quote = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        "/api/shipping-labels/shipengine/rates",
        {
          dealId,
          parcel: {
            lengthIn: Number(parcel.lengthIn),
            widthIn: Number(parcel.widthIn),
            heightIn: Number(parcel.heightIn),
            weightOz: Number(parcel.weightOz),
          },
        },
        { headers },
      );
      return (await response.json()) as RatesResponse;
    },
    onSuccess: (data) => {
      setRates(data.rates);
      setTestMode(data.testMode);
      setSelectedRateId(data.rates[0]?.rateId ?? "");
      setAddressHint(
        `${data.addressTo.name} · ${data.addressTo.street1}, ${data.addressTo.city}, ${data.addressTo.state} ${data.addressTo.zip}`,
      );
      toast({
        title: data.rates.length ? `${data.rates.length} rates` : "No rates",
        description: data.testMode
          ? "ShipEngine sandbox — purchases won’t charge live postage."
          : data.rates[0]
            ? `UPS-first: ${data.rates[0].carrierFriendlyName} ${data.rates[0].serviceType} $${data.rates[0].amount}`
            : data.messages[0] || "Try different box dims or connect UPS/USPS in ShipStation.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not get rates",
        description: formatShipEngineClientError(error.message),
        variant: "destructive",
      });
    },
  });

  const buy = useMutation({
    mutationFn: async () => {
      if (!selectedRate) throw new Error("Pick a rate first");
      const response = await apiRequest(
        "POST",
        "/api/shipping-labels/shipengine/purchase",
        {
          dealIds: [dealId],
          rateId: selectedRate.rateId,
          amount: selectedRate.amount,
          carrierCode: selectedRate.carrierCode,
          serviceType: selectedRate.serviceType,
          messageChannel,
          packingDone: true,
        },
        { headers },
      );
      return (await response.json()) as PurchaseResponse;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deal-ops"] });

      const tracking = data.shipengine?.trackingNumber ?? "";
      const dealIds = data.attachedDealIds?.length ? data.attachedDealIds : [dealId];
      const match = shipReadyPicks.find((row) => row.dealId === dealId);
      onPurchased({
        dealIds,
        dealName: match?.dealName ?? `Deal ${dealId}`,
        contactName: data.contact?.name ?? shipToQuery.data?.contact.name ?? null,
        contactEmail: data.contact?.email ?? shipToQuery.data?.contact.email ?? null,
        trackingNumber: tracking,
        service: data.shipengine?.serviceCode ?? selectedRate?.serviceType ?? null,
        carrier: data.shipengine?.carrierCode ?? selectedRate?.carrierFriendlyName ?? null,
        labelUrl: data.shipengine?.labelUrl ?? null,
      });
      setRates([]);
      setSelectedRateId("");
      toast({
        title: data.shipengine?.testMode ? "Test label bought" : "Label bought",
        description: tracking
          ? `${tracking} · $${data.shipengine?.amount ?? selectedRate?.amount ?? ""} attached`
          : data.message ?? "Tracking attached",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not buy label",
        description: formatShipEngineClientError(error.message),
        variant: "destructive",
      });
    },
  });

  const status = statusQuery.data;
  const shipToReady = shipToQuery.data?.ready ?? false;

  return (
    <Panel
      title="Buy with ShipEngine"
      description="Rate-shop UPS (and USPS), buy the label, and write tracking + postage onto the Print Order."
      testId="panel-labels-shipengine"
      actions={
        status?.testMode ? (
          <StatusPill tone="warn" icon={AlertTriangle} label="Sandbox key" />
        ) : status?.configured ? (
          <StatusPill tone="good" icon={CheckCircle2} label="ShipEngine ready" />
        ) : null
      }
    >
      {!status?.configured ? (
        <div className="glance-item flex-col items-stretch gap-2" data-tone="warn">
          <p className="text-sm font-semibold">ShipEngine isn’t fully configured yet</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {!status?.hasApiKey ? (
              <li>
                Set <code className="text-xs">SHIPENGINE_API_KEY</code> on Railway (ShipStation API /
                ShipEngine → API Keys).
              </li>
            ) : null}
            {!status?.hasShipFrom ? (
              <li>
                Set ship-from: <code className="text-xs">SHIP_FROM_NAME</code>,{" "}
                <code className="text-xs">STREET1</code>, <code className="text-xs">CITY</code>,{" "}
                <code className="text-xs">STATE</code>, <code className="text-xs">ZIP</code>.
              </li>
            ) : null}
            {status?.hasShipFrom && !status?.hasShipFromPhone ? (
              <li>
                Set <code className="text-xs">SHIP_FROM_PHONE</code> to your shop phone (required by
                ShipEngine; client phones are not used).
              </li>
            ) : null}
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          {status.carriersError ? (
            <div className="glance-item flex-col items-stretch gap-1" data-tone="warn">
              <p className="text-sm font-semibold">Couldn’t list carriers</p>
              <p className="text-sm text-muted-foreground">{status.carriersError}</p>
            </div>
          ) : status.carriers && status.carriers.length === 0 ? (
            <div className="glance-item flex-col items-stretch gap-1" data-tone="warn">
              <p className="text-sm font-semibold">No carriers connected</p>
              <p className="text-sm text-muted-foreground">
                In ShipStation / ShipEngine, connect UPS and/or USPS (Stamps.com), then refresh Labels.
              </p>
            </div>
          ) : status.carriers && status.carriers.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Carriers: {status.carriers.map((c) => c.friendlyName || c.carrierCode).join(" · ")}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="shipengine-deal-id">Print Order deal ID</Label>
              <Input
                id="shipengine-deal-id"
                value={dealId}
                onChange={(event) => {
                  setDealId(event.target.value.trim());
                  setRates([]);
                  setSelectedRateId("");
                }}
                placeholder="HubSpot deal id"
                data-testid="input-shipengine-deal-id"
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                disabled={!/^[0-9]{1,20}$/.test(dealId) || !shipToReady || quote.isPending}
                onClick={() => quote.mutate()}
                data-testid="button-shipengine-get-rates"
              >
                {quote.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Ship className="mr-2 h-4 w-4" />
                )}
                Get rates
              </Button>
            </div>
          </div>

          {shipReadyPicks.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {shipReadyPicks.map((item) => (
                <Button
                  key={item.dealId}
                  type="button"
                  size="sm"
                  variant={dealId === item.dealId ? "default" : "outline"}
                  onClick={() => {
                    setDealId(item.dealId);
                    setRates([]);
                    setSelectedRateId("");
                  }}
                  data-testid={`button-shipengine-pick-${item.dealId}`}
                >
                  {item.dealName.slice(0, 28)}
                  {item.fulfillment.labelBought ? " · labeled" : ""}
                </Button>
              ))}
            </div>
          ) : null}

          {shipToQuery.isFetching ? (
            <p className="text-xs text-muted-foreground">Loading HubSpot ship-to…</p>
          ) : shipToQuery.data ? (
            <div
              className={cn("glance-item flex-col items-stretch gap-1", !shipToReady && "opacity-90")}
              data-tone={shipToReady ? "good" : "warn"}
            >
              <p className="text-sm font-semibold">
                {shipToReady
                  ? "Ship to"
                  : shipToQuery.data.hasContact === false
                    ? "No HubSpot contact linked to this deal"
                    : "Ship-to incomplete on HubSpot contact"}
              </p>
              {shipToReady && shipToQuery.data.contact.addressLines.length ? (
                <p className="text-sm text-muted-foreground">
                  {[shipToQuery.data.contact.name, ...shipToQuery.data.contact.addressLines]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {shipToQuery.data.hasContact === false
                    ? "Associate the buyer contact on the HubSpot deal, then refresh."
                    : `Missing: ${(shipToQuery.data.missing || []).join(", ") || "address"}`}
                </p>
              )}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["weightOz", "Weight (oz)"],
                ["lengthIn", "Length (in)"],
                ["widthIn", "Width (in)"],
                ["heightIn", "Height (in)"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`shipengine-${key}`}>{label}</Label>
                <Input
                  id={`shipengine-${key}`}
                  inputMode="decimal"
                  value={parcel[key]}
                  onChange={(event) => {
                    setParcel((prev) => ({ ...prev, [key]: event.target.value }));
                    setRates([]);
                    setSelectedRateId("");
                  }}
                  data-testid={`input-shipengine-${key}`}
                />
              </div>
            ))}
          </div>

          {addressHint ? (
            <p className="text-xs text-muted-foreground">Quoted for {addressHint}</p>
          ) : null}

          {rates.length > 0 ? (
            <div className="space-y-2" data-testid="list-shipengine-rates">
              {testMode ? (
                <StatusPill tone="warn" icon={AlertTriangle} label="Sandbox — no live postage charge" />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Buying charges your ShipEngine / carrier balance. UPS rates are listed first.
                </p>
              )}
              <ul className="space-y-2">
                {rates.map((rate) => {
                  const selected = rate.rateId === selectedRateId;
                  const ups = /ups/i.test(rate.carrierCode) || /ups/i.test(rate.carrierFriendlyName);
                  return (
                    <li key={rate.rateId}>
                      <button
                        type="button"
                        className={cn(
                          "glance-item w-full items-center justify-between gap-3 text-left",
                          selected && "border-primary",
                        )}
                        data-tone={ups ? "good" : "neutral"}
                        data-testid={`button-shipengine-rate-${rate.rateId}`}
                        onClick={() => setSelectedRateId(rate.rateId)}
                      >
                        <span>
                          <span className="block text-sm font-semibold">
                            {rate.carrierFriendlyName} · {rate.serviceType}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {rate.deliveryDays != null
                              ? `${rate.deliveryDays} day${rate.deliveryDays === 1 ? "" : "s"}`
                              : "Transit varies"}
                            {rate.attributes.includes("cheapest") ? " · cheapest" : ""}
                            {rate.attributes.includes("fastest") ? " · fastest" : ""}
                          </span>
                        </span>
                        <span className="text-sm font-semibold tabular-nums">
                          {formatMoney(Number(rate.amount))}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={!selectedRate || buy.isPending}
                  onClick={() => {
                    if (!selectedRate) return;
                    const label = `${selectedRate.carrierFriendlyName} ${selectedRate.serviceType} for $${selectedRate.amount}`;
                    if (
                      !testMode &&
                      !window.confirm(`Buy ${label}? This charges your ShipEngine account.`)
                    ) {
                      return;
                    }
                    buy.mutate();
                  }}
                  data-testid="button-shipengine-buy"
                >
                  {buy.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Ship className="mr-2 h-4 w-4" />
                  )}
                  {selectedRate
                    ? `Buy ${selectedRate.carrierFriendlyName} · $${selectedRate.amount}`
                    : "Buy label"}
                </Button>
                {/^[0-9]{1,20}$/.test(dealId) ? (
                  <Button asChild size="default" variant="outline">
                    <Link href={queueDealHref(dealId)}>Open in Queue</Link>
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

export function ShipEngineLabelLink({ url }: { url: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <a href={url} target="_blank" rel="noreferrer">
        <ExternalLink className="mr-2 h-3.5 w-3.5" />
        Open label PDF
      </a>
    </Button>
  );
}
