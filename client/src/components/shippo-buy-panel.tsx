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

type ShippoStatus = {
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
};

type ShipToResponse = {
  ok: true;
  dealId: string;
  ready: boolean;
  missing: string[];
  contact: {
    id: string | null;
    name: string;
    email: string;
    phone: string;
    addressLines: string[];
    street1: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
};

type ShippoRate = {
  objectId: string;
  amount: string;
  currency: string;
  provider: string;
  servicelevelName: string;
  servicelevelToken: string;
  estimatedDays: number | null;
  durationTerms: string;
  attributes: string[];
};

type RatesResponse = {
  ok: true;
  dealId: string;
  testMode: boolean;
  shipmentId: string;
  addressTo: { name: string; street1: string; city: string; state: string; zip: string };
  rates: ShippoRate[];
  messages: string[];
};

type PurchaseResponse = {
  ok: true;
  duplicate?: boolean;
  message?: string;
  attachedDealIds?: string[];
  contact?: { id: string | null; name: string; email: string };
  shippo?: {
    trackingNumber: string;
    labelUrl: string | null;
    amount: string;
    provider: string;
    servicelevelName: string;
    test: boolean;
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

export function ShippoBuyPanel({
  headers,
  ownerCode,
  isUnlocked,
  prefillDealId,
  messageChannel,
  onPurchased,
}: Props) {
  const { toast } = useToast();
  const [dealId, setDealId] = useState(prefillDealId && /^[0-9]{1,20}$/.test(prefillDealId) ? prefillDealId : "");
  const [parcel, setParcel] = useState(DEFAULT_PARCEL);
  const [rates, setRates] = useState<ShippoRate[]>([]);
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

  const statusQuery = useQuery<ShippoStatus>({
    queryKey: ["/api/shipping-labels/shippo/status", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/shipping-labels/shippo/status", undefined, { headers });
      return response.json();
    },
  });

  const queueQuery = useQuery<{ ok: true } & ProductionQueueResponse>({
    queryKey: ["/api/production-queue", ownerCode, "shippo"],
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
    const items = [
      ...(queueQuery.data?.shipReady ?? []),
      ...(queueQuery.data?.inProduction ?? []),
    ];
    return items.slice(0, 8);
  }, [queueQuery.data]);

  const selectedRate = rates.find((rate) => rate.objectId === selectedRateId) ?? null;

  const quote = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        "/api/shipping-labels/shippo/rates",
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
      setSelectedRateId(data.rates[0]?.objectId ?? "");
      setAddressHint(
        `${data.addressTo.name} · ${data.addressTo.street1}, ${data.addressTo.city}, ${data.addressTo.state} ${data.addressTo.zip}`,
      );
      toast({
        title: data.rates.length ? `${data.rates.length} rates` : "No rates",
        description: data.testMode
          ? "Shippo test mode — purchases won’t charge a live carrier."
          : data.rates[0]
            ? `Cheapest/UPS-first: ${data.rates[0].provider} ${data.rates[0].servicelevelName} $${data.rates[0].amount}`
            : data.messages[0] || "Try different box dims or weight.",
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
        "/api/shipping-labels/shippo/purchase",
        {
          dealIds: [dealId],
          rateObjectId: selectedRate.objectId,
          amount: selectedRate.amount,
          provider: selectedRate.provider,
          servicelevelName: selectedRate.servicelevelName,
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

      const tracking = data.shippo?.trackingNumber ?? "";
      const dealIds = data.attachedDealIds?.length ? data.attachedDealIds : [dealId];
      const match = shipReadyPicks.find((row) => row.dealId === dealId);
      onPurchased({
        dealIds,
        dealName: match?.dealName ?? `Deal ${dealId}`,
        contactName: data.contact?.name ?? shipToQuery.data?.contact.name ?? null,
        contactEmail: data.contact?.email ?? shipToQuery.data?.contact.email ?? null,
        trackingNumber: tracking,
        service: data.shippo?.servicelevelName ?? selectedRate?.servicelevelName ?? null,
        carrier: data.shippo?.provider ?? selectedRate?.provider ?? null,
        labelUrl: data.shippo?.labelUrl ?? null,
      });
      setRates([]);
      setSelectedRateId("");
      toast({
        title: data.shippo?.test ? "Test label bought" : "Label bought",
        description: tracking
          ? `${tracking} · $${data.shippo?.amount ?? selectedRate?.amount ?? ""} attached`
          : data.message ?? "Tracking attached",
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
      title="Buy with Shippo"
      description="Rate-shop UPS (and other carriers), buy the label, and write tracking + postage onto the Print Order."
      testId="panel-labels-shippo"
      actions={
        status?.testMode ? (
          <StatusPill tone="warn" icon={AlertTriangle} label="Test API key" />
        ) : status?.configured ? (
          <StatusPill tone="good" icon={CheckCircle2} label="Shippo ready" />
        ) : null
      }
    >
      {!status?.configured ? (
        <div className="glance-item flex-col items-stretch gap-2" data-tone="warn">
          <p className="text-sm font-semibold">Shippo isn’t configured on Railway yet</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {!status?.hasApiKey ? (
              <li>
                In Shippo → Settings → API, copy a token and set <code className="text-xs">SHIPPO_API_KEY</code>{" "}
                on HubSpotHost (use <code className="text-xs">shippo_test_…</code> first).
              </li>
            ) : null}
            {!status?.hasShipFrom ? (
              <li>
                Set ship-from: <code className="text-xs">SHIP_FROM_NAME</code>,{" "}
                <code className="text-xs">SHIP_FROM_STREET1</code>,{" "}
                <code className="text-xs">SHIP_FROM_CITY</code>,{" "}
                <code className="text-xs">SHIP_FROM_STATE</code>,{" "}
                <code className="text-xs">SHIP_FROM_ZIP</code>.
              </li>
            ) : null}
          </ul>
          {status?.shipFrom ? (
            <p className="text-xs text-muted-foreground">
              From: {status.shipFrom.name}, {status.shipFrom.street1}, {status.shipFrom.city}{" "}
              {status.shipFrom.state} {status.shipFrom.zip}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="shippo-deal-id">Print Order deal ID</Label>
              <Input
                id="shippo-deal-id"
                value={dealId}
                onChange={(event) => {
                  setDealId(event.target.value.trim());
                  setRates([]);
                  setSelectedRateId("");
                }}
                placeholder="HubSpot deal id"
                data-testid="input-shippo-deal-id"
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                disabled={!/^[0-9]{1,20}$/.test(dealId) || !shipToReady || quote.isPending}
                onClick={() => quote.mutate()}
                data-testid="button-shippo-get-rates"
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
                  data-testid={`button-shippo-pick-${item.dealId}`}
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
                {shipToReady ? "Ship to" : "Ship-to incomplete on HubSpot contact"}
              </p>
              {shipToQuery.data.contact.addressLines.length ? (
                <p className="text-sm text-muted-foreground">
                  {[shipToQuery.data.contact.name, ...shipToQuery.data.contact.addressLines]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Missing: {(shipToQuery.data.missing || []).join(", ") || "address"}
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
                <Label htmlFor={`shippo-${key}`}>{label}</Label>
                <Input
                  id={`shippo-${key}`}
                  inputMode="decimal"
                  value={parcel[key]}
                  onChange={(event) => {
                    setParcel((prev) => ({ ...prev, [key]: event.target.value }));
                    setRates([]);
                    setSelectedRateId("");
                  }}
                  data-testid={`input-shippo-${key}`}
                />
              </div>
            ))}
          </div>

          {addressHint ? (
            <p className="text-xs text-muted-foreground">Quoted for {addressHint}</p>
          ) : null}

          {rates.length > 0 ? (
            <div className="space-y-2" data-testid="list-shippo-rates">
              {testMode ? (
                <StatusPill tone="warn" icon={AlertTriangle} label="Test mode — no live postage charge" />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Buying charges your Shippo / carrier balance. UPS rates are listed first.
                </p>
              )}
              <ul className="space-y-2">
                {rates.map((rate) => {
                  const selected = rate.objectId === selectedRateId;
                  const ups = /ups/i.test(rate.provider);
                  return (
                    <li key={rate.objectId}>
                      <button
                        type="button"
                        className={cn(
                          "glance-item w-full items-center justify-between gap-3 text-left",
                          selected && "border-primary",
                        )}
                        data-tone={ups ? "good" : "neutral"}
                        data-testid={`button-shippo-rate-${rate.objectId}`}
                        onClick={() => setSelectedRateId(rate.objectId)}
                      >
                        <span>
                          <span className="block text-sm font-semibold">
                            {rate.provider} · {rate.servicelevelName}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {rate.estimatedDays != null
                              ? `${rate.estimatedDays} day${rate.estimatedDays === 1 ? "" : "s"}`
                              : rate.durationTerms || "Transit varies"}
                            {rate.attributes.includes("CHEAPEST") ? " · cheapest" : ""}
                            {rate.attributes.includes("FASTEST") ? " · fastest" : ""}
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
                    const label = `${selectedRate.provider} ${selectedRate.servicelevelName} for $${selectedRate.amount}`;
                    if (
                      !testMode &&
                      !window.confirm(`Buy ${label}? This charges your Shippo account.`)
                    ) {
                      return;
                    }
                    buy.mutate();
                  }}
                  data-testid="button-shippo-buy"
                >
                  {buy.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Ship className="mr-2 h-4 w-4" />
                  )}
                  {selectedRate
                    ? `Buy ${selectedRate.provider} · $${selectedRate.amount}`
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

export function ShippoLabelLink({ url }: { url: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <a href={url} target="_blank" rel="noreferrer">
        <ExternalLink className="mr-2 h-3.5 w-3.5" />
        Open label PDF
      </a>
    </Button>
  );
}
