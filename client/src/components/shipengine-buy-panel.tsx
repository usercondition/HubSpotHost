import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Loader2, Ship, AlertTriangle, ExternalLink, CheckCircle2, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Panel, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { queueDealHref } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import {
  filterShopShippingRates,
  isShopUsualBoxRate,
  type ShippingRatePrefMode,
} from "@shared/shipping-rate-prefs";
import type { ProductionQueueResponse } from "@shared/schema";

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

type RateSort = "recommended" | "cheapest" | "fastest";
type CarrierFilter = "all" | "ups" | "usps" | "other";

function isUpsRate(rate: ShipEngineRate): boolean {
  return /ups/i.test(rate.carrierCode) || /ups/i.test(rate.carrierFriendlyName);
}

function isUspsRate(rate: ShipEngineRate): boolean {
  return (
    /usps|stamps/i.test(rate.carrierCode) || /usps|stamps/i.test(rate.carrierFriendlyName)
  );
}

function rateAmount(rate: ShipEngineRate): number {
  const n = Number(rate.amount);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function rateDays(rate: ShipEngineRate): number {
  return rate.deliveryDays == null ? Number.POSITIVE_INFINITY : rate.deliveryDays;
}

function sortRates(rates: ShipEngineRate[], sort: RateSort): ShipEngineRate[] {
  const next = [...rates];
  if (sort === "cheapest") {
    return next.sort((a, b) => rateAmount(a) - rateAmount(b) || rateDays(a) - rateDays(b));
  }
  if (sort === "fastest") {
    return next.sort((a, b) => rateDays(a) - rateDays(b) || rateAmount(a) - rateAmount(b));
  }
  // recommended: usual box services first, UPS within that, then cheapest
  return next.sort((a, b) => {
    const aUsual = isShopUsualBoxRate(a) ? 0 : 1;
    const bUsual = isShopUsualBoxRate(b) ? 0 : 1;
    if (aUsual !== bUsual) return aUsual - bUsual;
    const aUps = isUpsRate(a) ? 0 : 1;
    const bUps = isUpsRate(b) ? 0 : 1;
    if (aUps !== bUps) return aUps - bUps;
    return rateAmount(a) - rateAmount(b) || rateDays(a) - rateDays(b);
  });
}

function filterRates(rates: ShipEngineRate[], filter: CarrierFilter): ShipEngineRate[] {
  if (filter === "ups") return rates.filter(isUpsRate);
  if (filter === "usps") return rates.filter(isUspsRate);
  if (filter === "other") return rates.filter((rate) => !isUpsRate(rate) && !isUspsRate(rate));
  return rates;
}

function formatRatePrice(amount: string): string {
  const n = Number(amount);
  return Number.isFinite(n) ? formatMoney(n) : `$${amount}`;
}

function formatTransit(days: number | null): string {
  if (days == null) return "—";
  return days === 1 ? "1 day" : `${days} days`;
}

type ShipEngineStatus = {
  ok: true;
  configured: boolean;
  hasApiKey: boolean;
  hasShipFrom: boolean;
  testMode: boolean | null;
  shipFrom: {
    name: string;
    street1: string;
    street2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
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
  stageMoves?: Array<{
    dealId: string;
    ok: boolean;
    dryRun?: boolean;
    stageLabel?: string;
    error?: string;
  }>;
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
  const [rateSort, setRateSort] = useState<RateSort>("recommended");
  const [carrierFilter, setCarrierFilter] = useState<CarrierFilter>("all");
  const [ratePrefMode, setRatePrefMode] = useState<ShippingRatePrefMode>("usual");

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

  const preferredRates = useMemo(
    () => filterShopShippingRates(rates, ratePrefMode),
    [rates, ratePrefMode],
  );

  const visibleRates = useMemo(
    () => sortRates(filterRates(preferredRates, carrierFilter), rateSort),
    [preferredRates, carrierFilter, rateSort],
  );

  const carrierCounts = useMemo(() => {
    let ups = 0;
    let usps = 0;
    let other = 0;
    for (const rate of preferredRates) {
      if (isUpsRate(rate)) ups += 1;
      else if (isUspsRate(rate)) usps += 1;
      else other += 1;
    }
    return { ups, usps, other, all: preferredRates.length };
  }, [preferredRates]);

  const hiddenUsualCount = useMemo(() => {
    if (ratePrefMode !== "usual") return 0;
    const boxed = filterShopShippingRates(rates, "all");
    return Math.max(0, boxed.length - filterShopShippingRates(rates, "usual").length);
  }, [rates, ratePrefMode]);

  const selectedRate =
    rates.find((rate) => rate.rateId === selectedRateId) ??
    visibleRates[0] ??
    null;

  useEffect(() => {
    if (!rates.length) return;
    if (selectedRateId && visibleRates.some((rate) => rate.rateId === selectedRateId)) return;
    setSelectedRateId(visibleRates[0]?.rateId ?? "");
  }, [rates, visibleRates, selectedRateId]);

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
      setRateSort("recommended");
      setCarrierFilter("all");
      setRatePrefMode("usual");
      const usualFirst = filterShopShippingRates(data.rates, "usual")[0];
      setSelectedRateId(usualFirst?.rateId ?? data.rates[0]?.rateId ?? "");
      setAddressHint(
        `${data.addressTo.name} · ${data.addressTo.street1}, ${data.addressTo.city}, ${data.addressTo.state} ${data.addressTo.zip}`,
      );
      toast({
        title: data.rates.length ? `${data.rates.length} rates` : "No rates",
        description: data.testMode
          ? "ShipEngine sandbox — purchases won’t charge live postage."
          : usualFirst
            ? `Usual boxes: ${usualFirst.carrierFriendlyName} ${usualFirst.serviceType} $${usualFirst.amount}`
            : data.messages[0] || "Try different box dims or connect UPS/USPS in ShipStation.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not get rates",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 240),
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
      const completed = (data.stageMoves ?? []).filter((row) => row.ok);
      const stageHint = completed[0]?.stageLabel
        ? ` · moved to ${completed[0].stageLabel}`
        : data.stageMoves?.some((row) => !row.ok)
          ? " · tracking saved (stage move failed)"
          : "";
      toast({
        title: data.shipengine?.testMode ? "Test label bought" : "Label bought",
        description: tracking
          ? `${tracking} · $${data.shipengine?.amount ?? selectedRate?.amount ?? ""} attached${stageHint}`
          : data.message ?? `Tracking attached${stageHint}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not buy label",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 240),
        variant: "destructive",
      });
    },
  });

  const status = statusQuery.data;
  const shipToReady = shipToQuery.data?.ready ?? false;

  return (
    <Panel
      title="Buy with ShipEngine"
      description="Rate-shop UPS (and USPS), buy the label, write tracking + postage, and move the Print Order to Completed."
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
            <div className="space-y-3" data-testid="list-shipengine-rates">
              {testMode ? (
                <StatusPill tone="warn" icon={AlertTriangle} label="Sandbox — no live postage charge" />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Usual = box services you actually buy (UPS Ground / USPS Ground Advantage &amp; Priority).
                  Envelopes are hidden.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Services</span>
                {(
                  [
                    ["usual", "Usual boxes"],
                    ["all", "All package rates"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={ratePrefMode === value ? "default" : "outline"}
                    onClick={() => setRatePrefMode(value)}
                    data-testid={`button-shipengine-pref-${value}`}
                  >
                    {label}
                  </Button>
                ))}
                {hiddenUsualCount > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    +{hiddenUsualCount} express / other hidden
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  Sort
                </span>
                {(
                  [
                    ["recommended", "Recommended"],
                    ["cheapest", "Cheapest"],
                    ["fastest", "Fastest"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={rateSort === value ? "default" : "outline"}
                    onClick={() => setRateSort(value)}
                    data-testid={`button-shipengine-sort-${value}`}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Carrier</span>
                {(
                  [
                    ["all", `All (${carrierCounts.all})`] as const,
                    ["ups", `UPS (${carrierCounts.ups})`] as const,
                    ["usps", `USPS (${carrierCounts.usps})`] as const,
                    ...(carrierCounts.other > 0
                      ? ([["other", `Other (${carrierCounts.other})`]] as Array<
                          [CarrierFilter, string]
                        >)
                      : []),
                  ] satisfies Array<[CarrierFilter, string]>
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={carrierFilter === value ? "default" : "outline"}
                    onClick={() => setCarrierFilter(value)}
                    data-testid={`button-shipengine-filter-${value}`}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              <div className="overflow-hidden rounded-md border border-border/70">
                <div className="max-h-64 overflow-auto">
                  <table className="w-full caption-bottom text-sm">
                    <thead className="sticky top-0 z-10 border-b bg-background">
                      <tr>
                        <th className="h-9 px-3 text-left font-medium text-muted-foreground">
                          Carrier
                        </th>
                        <th className="h-9 px-3 text-left font-medium text-muted-foreground">
                          Service
                        </th>
                        <th className="h-9 w-[5.5rem] px-3 text-left font-medium text-muted-foreground">
                          Transit
                        </th>
                        <th className="h-9 w-[5.5rem] px-3 text-right font-medium text-muted-foreground">
                          Price
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRates.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                            No rates for this carrier filter.
                          </td>
                        </tr>
                      ) : (
                        visibleRates.map((rate) => {
                          const selected = rate.rateId === selectedRate?.rateId;
                          const tags = [
                            rate.attributes.includes("cheapest") ? "cheapest" : null,
                            rate.attributes.includes("fastest") ? "fastest" : null,
                          ].filter(Boolean);
                          return (
                            <tr
                              key={rate.rateId}
                              role="button"
                              tabIndex={0}
                              className={cn(
                                "border-b last:border-0 cursor-pointer transition-colors hover:bg-muted/50",
                                selected && "bg-primary/10 hover:bg-primary/15",
                              )}
                              data-testid={`button-shipengine-rate-${rate.rateId}`}
                              onClick={() => setSelectedRateId(rate.rateId)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setSelectedRateId(rate.rateId);
                                }
                              }}
                            >
                              <td className="px-3 py-2 font-medium">
                                {rate.carrierFriendlyName || rate.carrierCode}
                              </td>
                              <td className="px-3 py-2">
                                <span className="block">{rate.serviceType}</span>
                                {tags.length ? (
                                  <span className="text-xs text-muted-foreground">
                                    {tags.join(" · ")}
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-3 py-2 tabular-nums text-muted-foreground">
                                {formatTransit(rate.deliveryDays)}
                              </td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums">
                                {formatRatePrice(rate.amount)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/30 px-3 py-3">
                  <div className="min-w-0 text-sm">
                    {selectedRate ? (
                      <>
                        <p className="font-semibold truncate">
                          {selectedRate.carrierFriendlyName} · {selectedRate.serviceType}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatTransit(selectedRate.deliveryDays)} ·{" "}
                          <span className="font-semibold tabular-nums text-foreground">
                            {formatRatePrice(selectedRate.amount)}
                          </span>
                        </p>
                      </>
                    ) : (
                      <p className="text-muted-foreground">Select a rate to buy</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={!selectedRate || buy.isPending}
                      onClick={() => {
                        if (!selectedRate) return;
                        const label = `${selectedRate.carrierFriendlyName} ${selectedRate.serviceType} for ${formatRatePrice(selectedRate.amount)}`;
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
                        ? `Buy · ${formatRatePrice(selectedRate.amount)}`
                        : "Buy label"}
                    </Button>
                    {/^[0-9]{1,20}$/.test(dealId) ? (
                      <Button asChild size="default" variant="outline">
                        <Link href={queueDealHref(dealId)}>Open in Queue</Link>
                      </Button>
                    ) : null}
                  </div>
                </div>
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
