import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Loader2,
  Ship,
  AlertTriangle,
  ExternalLink,
  CheckCircle2,
  ArrowUpDown,
  Wallet,
  Plus,
  PackageCheck,
  ChevronDown,
  X,
  MapPin,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { addressStatusPill } from "@shared/ship-address";
import type { ProductionQueueItem, ProductionQueueResponse } from "@shared/schema";

const ADD_FUND_PRESETS = [10, 25, 50, 100] as const;

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

type ShipEngineFundedCarrier = {
  carrierId: string;
  carrierCode: string;
  friendlyName: string;
  balance: number;
};

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
  carriers?: Array<{
    carrierId: string;
    carrierCode: string;
    friendlyName: string;
    requiresFundedAmount?: boolean;
    balance?: number | null;
  }>;
  funds?: {
    availableUsd: number | null;
    sharedWallet: boolean;
    lowestBalanceUsd: number | null;
    fundedCarriers: ShipEngineFundedCarrier[];
  } | null;
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
  const [addFundsOpen, setAddFundsOpen] = useState(false);
  const [addFundsCarrierId, setAddFundsCarrierId] = useState("");
  const [addFundsAmount, setAddFundsAmount] = useState("25");

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

  const fundedCarriers = useMemo(() => {
    const fromApi = statusQuery.data?.funds?.fundedCarriers;
    if (fromApi && fromApi.length > 0) return fromApi;
    return (statusQuery.data?.carriers ?? [])
      .filter(
        (carrier) =>
          carrier.requiresFundedAmount !== false &&
          typeof carrier.balance === "number" &&
          Number.isFinite(carrier.balance),
      )
      .map((carrier) => ({
        carrierId: carrier.carrierId,
        carrierCode: carrier.carrierCode,
        friendlyName: carrier.friendlyName || carrier.carrierCode,
        balance: carrier.balance as number,
      }));
  }, [statusQuery.data]);

  useEffect(() => {
    if (!addFundsOpen) return;
    if (addFundsCarrierId && fundedCarriers.some((row) => row.carrierId === addFundsCarrierId)) {
      return;
    }
    const lowest = [...fundedCarriers].sort((a, b) => a.balance - b.balance)[0];
    setAddFundsCarrierId(lowest?.carrierId ?? fundedCarriers[0]?.carrierId ?? "");
  }, [addFundsOpen, fundedCarriers, addFundsCarrierId]);

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
    const shipReady = queueQuery.data?.shipReady ?? [];
    const readyToPack = queueQuery.data?.readyToPack ?? [];
    const inProduction = queueQuery.data?.inProduction ?? [];
    const seen = new Set<string>();
    const picks = [];
    for (const item of [...shipReady, ...readyToPack, ...inProduction]) {
      if (seen.has(item.dealId)) continue;
      seen.add(item.dealId);
      picks.push(item);
      if (picks.length >= 10) break;
    }
    return picks;
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
      queryClient.invalidateQueries({ queryKey: ["/api/shipping-labels/shipengine/status"] });

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
        description: formatShipEngineClientError(error.message),
        variant: "destructive",
      });
    },
  });

  const addFunds = useMutation({
    mutationFn: async () => {
      const amount = Number(addFundsAmount);
      if (!addFundsCarrierId) throw new Error("Pick a funded carrier wallet");
      if (!Number.isFinite(amount) || amount < 10) {
        throw new Error("Minimum add is $10");
      }
      const response = await apiRequest(
        "POST",
        "/api/shipping-labels/shipengine/add-funds",
        {
          carrierId: addFundsCarrierId,
          amount,
          currency: "usd",
        },
        { headers },
      );
      return (await response.json()) as {
        ok: true;
        friendlyName: string;
        amountAdded: number;
        balance: number;
        currency: string;
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/shipping-labels/shipengine/status"] });
      setAddFundsOpen(false);
      toast({
        title: "Funds added",
        description: `Added $${Number(data.amountAdded).toFixed(2)} to ${data.friendlyName}. Balance now $${Number(data.balance).toFixed(2)}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not add funds",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 280),
        variant: "destructive",
      });
    },
  });

  const status = statusQuery.data;
  const shipToReady = shipToQuery.data?.ready ?? false;
  const selectedPick = useMemo(
    () => shipReadyPicks.find((row) => row.dealId === dealId) ?? null,
    [shipReadyPicks, dealId],
  );
  const hasActiveDeal = /^[0-9]{1,20}$/.test(dealId);
  const queueAddressStatus = selectedPick?.addressStatus;
  const showAddressWarn =
    Boolean(hasActiveDeal) &&
    ((shipToQuery.data && !shipToReady) ||
      (queueAddressStatus && queueAddressStatus !== "ready" && !shipToReady));

  const copyChaseDraft = async (item: ProductionQueueItem) => {
    const draft = item.chaseDraft?.trim();
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      toast({
        title: "Chase draft copied",
        description: "Paste into Messenger or email — nothing was sent.",
      });
    } catch {
      toast({
        title: "Could not copy",
        description: draft.slice(0, 140),
        variant: "destructive",
      });
    }
  };

  const addressChip = (item: ProductionQueueItem) => {
    const pill = addressStatusPill(item.addressStatus ?? "missing");
    return (
      <StatusPill
        tone={pill.tone}
        icon={MapPin}
        label={
          item.addressStatus === "ready" && item.addressSummary
            ? `Address · ${item.addressSummary}`
            : pill.label
        }
        testId={`status-shipengine-address-${item.dealId}`}
      />
    );
  };
  const funds = status?.funds;
  const availableUsd = useMemo(() => {
    if (typeof funds?.availableUsd === "number" && Number.isFinite(funds.availableUsd)) {
      return funds.availableUsd;
    }
    if (fundedCarriers.length === 0) return null;
    const amounts = fundedCarriers.map((row) => row.balance);
    const first = amounts[0]!;
    const shared = amounts.every((amount) => Math.abs(amount - first) < 0.005);
    return shared ? first : amounts.reduce((sum, amount) => sum + amount, 0);
  }, [funds?.availableUsd, fundedCarriers]);
  const fundsLow =
    typeof funds?.lowestBalanceUsd === "number"
      ? funds.lowestBalanceUsd < 5
      : availableUsd != null && availableUsd < 5;
  const fundsEmpty =
    typeof funds?.lowestBalanceUsd === "number"
      ? funds.lowestBalanceUsd <= 0
      : availableUsd != null && availableUsd <= 0;
  const selectedAddFundsCarrier =
    fundedCarriers.find((row) => row.carrierId === addFundsCarrierId) ?? null;
  const addFundsAmountNum = Number(addFundsAmount);
  const canSubmitAddFunds =
    Boolean(addFundsCarrierId) &&
    Number.isFinite(addFundsAmountNum) &&
    addFundsAmountNum >= 10 &&
    !addFunds.isPending;

  function selectDeal(nextId: string) {
    setDealId(nextId);
    setRates([]);
    setSelectedRateId("");
    setAddressHint("");
  }

  function clearActiveDeal() {
    selectDeal("");
  }

  const parcelFields = (
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
  );

  const shipToBlock =
    !hasActiveDeal ? null : shipToQuery.isFetching ? (
      <p className="text-xs text-muted-foreground">Loading HubSpot ship-to…</p>
    ) : shipToQuery.data ? (
      <div
        className={cn("glance-item flex-col items-stretch gap-1", !shipToReady && "opacity-90")}
        data-tone={shipToReady ? "good" : "warn"}
        data-testid="panel-shipengine-ship-to"
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
        {!shipToReady && selectedPick?.chaseDraft ? (
          <div className="mt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyChaseDraft(selectedPick)}
              data-testid="button-shipengine-copy-chase"
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copy chase draft
            </Button>
          </div>
        ) : null}
      </div>
    ) : null;

  const ratesBlock =
    rates.length > 0 ? (
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
                ? ([["other", `Other (${carrierCounts.other})`]] as Array<[CarrierFilter, string]>)
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
                  <th className="h-9 px-3 text-left font-medium text-muted-foreground">Carrier</th>
                  <th className="h-9 px-3 text-left font-medium text-muted-foreground">Service</th>
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
                          "cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/50",
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
                            <span className="text-xs text-muted-foreground">{tags.join(" · ")}</span>
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
                  <p className="truncate font-semibold">
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
                {selectedRate ? `Buy · ${formatRatePrice(selectedRate.amount)}` : "Buy label"}
              </Button>
              {hasActiveDeal ? (
                <Button asChild size="default" variant="outline">
                  <Link href={queueDealHref(dealId)}>Open in Queue</Link>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    ) : null;

  const activeOrderWorkspace = hasActiveDeal ? (
    <div className="space-y-3 border-t border-border/60 pt-3" data-testid="panel-shipengine-active-order-body">
      {shipToBlock}
      {parcelFields}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={!shipToReady || quote.isPending}
          onClick={() => quote.mutate()}
          data-testid="button-shipengine-get-rates"
          title={!shipToReady ? "Fix HubSpot ship-to before rate shopping" : undefined}
        >
          {quote.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Ship className="mr-2 h-4 w-4" />
          )}
          Get rates
        </Button>
        {showAddressWarn ? (
          <StatusPill tone="warn" icon={AlertTriangle} label="Address required for rates" />
        ) : null}
        {addressHint ? (
          <p className="text-xs text-muted-foreground">Quoted for {addressHint}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set weight + box, then rate-shop for this order only.
          </p>
        )}
      </div>
      {ratesBlock}
    </div>
  ) : null;

  return (
    <>
    <Panel
      title="Buy with ShipEngine"
      description="Rate-shop, buy the label, write tracking + postage, and complete the Print Order — same flow as Queue ops, without leaving Print Ops."
      testId="panel-labels-shipengine"
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {status?.testMode ? (
            <StatusPill tone="warn" icon={AlertTriangle} label="Sandbox key" />
          ) : status?.configured ? (
            <StatusPill tone="good" icon={CheckCircle2} label="ShipEngine ready" />
          ) : null}
          {availableUsd != null ? (
            <StatusPill
              tone={fundsEmpty ? "bad" : fundsLow ? "warn" : "good"}
              icon={Wallet}
              label={`Available ${formatMoney(availableUsd)}`}
              testId="status-shipengine-available-funds"
            />
          ) : null}
        </div>
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
          ) : (
            <div
              className="glance-item flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"
              data-tone={fundsEmpty ? "bad" : fundsLow ? "warn" : "good"}
              data-testid="panel-shipengine-wallet"
            >
              <div className="min-w-0 space-y-1">
                <p className="rule-label mb-0">ShipStation funds</p>
                <p
                  className="text-2xl font-semibold tracking-tight numeric"
                  data-testid="text-shipengine-available-funds"
                >
                  {availableUsd != null ? formatMoney(availableUsd) : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {funds?.sharedWallet
                    ? "Shared prepaid wallet across funded carriers (not summed per carrier)."
                    : fundedCarriers.length > 1
                      ? "Total across funded carrier wallets."
                      : status.carriers && status.carriers.length > 0
                        ? `Carriers: ${status.carriers.map((c) => c.friendlyName || c.carrierCode).join(" · ")}`
                        : "Funded postage balance from ShipEngine."}
                </p>
                {fundedCarriers.length > 0 ? (
                  <div
                    className="flex flex-wrap gap-1.5 pt-1"
                    data-testid="panel-shipengine-carrier-balances"
                  >
                    {fundedCarriers.map((carrier) => {
                      const low = carrier.balance < 5;
                      const empty = carrier.balance <= 0;
                      return (
                        <StatusPill
                          key={carrier.carrierId}
                          tone={empty ? "bad" : low ? "warn" : "good"}
                          icon={empty || low ? AlertTriangle : CheckCircle2}
                          label={`${carrier.friendlyName} $${carrier.balance.toFixed(2)}`}
                          testId={`status-shipengine-balance-${carrier.carrierCode}`}
                        />
                      );
                    })}
                    {(status.carriers ?? [])
                      .filter((carrier) => carrier.requiresFundedAmount === false)
                      .map((carrier) => (
                        <StatusPill
                          key={carrier.carrierId}
                          tone="neutral"
                          icon={Ship}
                          label={carrier.friendlyName || carrier.carrierCode}
                          testId={`status-shipengine-balance-${carrier.carrierCode}`}
                        />
                      ))}
                  </div>
                ) : status.carriers && status.carriers.length > 0 ? (
                  <p className="pt-1 text-xs text-muted-foreground">
                    Carriers: {status.carriers.map((c) => c.friendlyName || c.carrierCode).join(" · ")}
                  </p>
                ) : null}
                {fundsEmpty ? (
                  <p className="text-xs text-destructive">
                    Wallet is at $0 — add funds here before buying a funded-carrier label.
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={fundsEmpty || fundsLow ? "default" : "outline"}
                  disabled={fundedCarriers.length === 0}
                  onClick={() => setAddFundsOpen(true)}
                  data-testid="button-shipengine-add-funds"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add funds
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={statusQuery.isFetching}
                  onClick={() => void statusQuery.refetch()}
                  data-testid="button-shipengine-refresh-funds"
                >
                  {statusQuery.isFetching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Refresh"
                  )}
                </Button>
              </div>
            </div>
          )}

          {shipReadyPicks.length > 0 ? (
            <div className="space-y-2" data-testid="panel-shipengine-order-picks">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold tracking-tight">Ready to label</p>
                  <p className="text-xs text-muted-foreground">
                    Tap an order to open its label card — ship-to, box, and rates stay on that order.
                  </p>
                </div>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {shipReadyPicks.length} shown
                </p>
              </div>
              <ul className="glance-list">
                {shipReadyPicks.map((item) => {
                  const selected = dealId === item.dealId;
                  const labeled = item.fulfillment.labelBought;
                  const packed = item.fulfillment.packingDone;
                  const tone = labeled
                    ? "good"
                    : item.readyToPack || item.fulfillment.shipReady
                      ? "good"
                      : item.bucket === "ship_ready"
                        ? "good"
                        : undefined;

                  if (selected) {
                    return (
                      <li key={item.dealId}>
                        <div
                          className="workspace-node space-y-0 p-3"
                          data-active="true"
                          data-tone="good"
                          data-testid={`panel-shipengine-order-card-${item.dealId}`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="rule-label mb-0.5">Labeling this order</p>
                              <p
                                className="truncate text-base font-semibold tracking-tight"
                                data-testid="text-shipengine-active-order-name"
                              >
                                {item.dealName}
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {item.stage}
                                {item.contactName ? ` · ${item.contactName}` : ""}
                                {` · ${item.dealId}`}
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              <p className="text-sm font-medium tabular-nums">
                                {formatMoney(item.amount)}
                              </p>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={clearActiveDeal}
                                data-testid="button-shipengine-close-order-card"
                                aria-label="Close order card"
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <StatusPill tone="good" icon={CheckCircle2} label="Open" />
                            {item.readyToPack ? (
                              <StatusPill tone="good" icon={PackageCheck} label="Ready to pack" />
                            ) : null}
                            {addressChip(item)}
                            {labeled ? (
                              <StatusPill tone="good" icon={CheckCircle2} label="Labeled" />
                            ) : (
                              <StatusPill tone="warn" icon={Ship} label="Needs label" />
                            )}
                            {packed ? (
                              <StatusPill tone="neutral" icon={PackageCheck} label="Packed" />
                            ) : null}
                            <StatusPill
                              tone={item.fulfillment.shipReady ? "good" : "neutral"}
                              icon={Ship}
                              label={`Ship ${item.fulfillment.readyPercent}%`}
                            />
                            {item.addressStatus !== "ready" && item.chaseDraft ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void copyChaseDraft(item);
                                }}
                                data-testid={`button-shipengine-card-chase-${item.dealId}`}
                              >
                                <Copy className="mr-1.5 h-3.5 w-3.5" />
                                Chase
                              </Button>
                            ) : null}
                          </div>
                          {activeOrderWorkspace}
                        </div>
                      </li>
                    );
                  }

                  return (
                    <li key={item.dealId}>
                      <button
                        type="button"
                        className="glance-item w-full text-left"
                        data-tone={tone}
                        data-testid={`button-shipengine-pick-${item.dealId}`}
                        onClick={() => selectDeal(item.dealId)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-start justify-between gap-2">
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold tracking-tight">
                                {item.dealName}
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {item.stage}
                                {item.contactName ? ` · ${item.contactName}` : ""}
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-medium tabular-nums">
                              {formatMoney(item.amount)}
                            </span>
                          </span>
                          <span className="mt-2 flex flex-wrap gap-1.5">
                            {item.readyToPack ? (
                              <StatusPill tone="good" icon={PackageCheck} label="Ready to pack" />
                            ) : null}
                            {addressChip(item)}
                            {labeled ? (
                              <StatusPill tone="good" icon={CheckCircle2} label="Labeled" />
                            ) : (
                              <StatusPill tone="warn" icon={Ship} label="Needs label" />
                            )}
                            {packed ? (
                              <StatusPill tone="neutral" icon={PackageCheck} label="Packed" />
                            ) : null}
                            <StatusPill
                              tone={item.fulfillment.shipReady ? "good" : "neutral"}
                              icon={Ship}
                              label={`Ship ${item.fulfillment.readyPercent}%`}
                            />
                          </span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          Open
                          <ChevronDown className="h-3.5 w-3.5" />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {!selectedPick ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor="shipengine-deal-id">
                    {shipReadyPicks.length > 0 ? "Or paste deal ID" : "Print Order deal ID"}
                  </Label>
                  <Input
                    id="shipengine-deal-id"
                    value={dealId}
                    onChange={(event) => selectDeal(event.target.value.trim())}
                    placeholder="HubSpot deal id"
                    data-testid="input-shipengine-deal-id"
                  />
                </div>
                {hasActiveDeal ? (
                  <div className="flex items-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={clearActiveDeal}
                      data-testid="button-shipengine-clear-deal-id"
                    >
                      Clear
                    </Button>
                  </div>
                ) : null}
              </div>

              {hasActiveDeal ? (
                <div
                  className="workspace-node space-y-0 p-3"
                  data-active="true"
                  data-tone="good"
                  data-testid="panel-shipengine-manual-order-card"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="rule-label mb-0.5">Labeling this order</p>
                      <p
                        className="truncate text-base font-semibold tracking-tight"
                        data-testid="text-shipengine-active-order-name"
                      >
                        Deal {dealId}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Pasted deal id · not in the Ready to label list above
                      </p>
                    </div>
                    <StatusPill tone="good" icon={CheckCircle2} label="Open" />
                  </div>
                  {activeOrderWorkspace}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Panel>

    <Dialog open={addFundsOpen} onOpenChange={setAddFundsOpen}>
      <DialogContent className="max-w-md" data-testid="dialog-shipengine-add-funds">
        <DialogHeader>
          <DialogTitle>Add ShipStation funds</DialogTitle>
          <DialogDescription>
            Charges your ShipStation payment method and credits a funded carrier wallet. There is no
            sandbox for this — live only. ShipStation Support must have enabled{" "}
            <code className="text-xs">add_funds</code> on the account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="shipengine-add-funds-carrier">Wallet</Label>
            <select
              id="shipengine-add-funds-carrier"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
              value={addFundsCarrierId}
              onChange={(event) => setAddFundsCarrierId(event.target.value)}
              data-testid="select-shipengine-add-funds-carrier"
            >
              {fundedCarriers.length === 0 ? (
                <option value="">No funded carriers</option>
              ) : (
                fundedCarriers.map((carrier) => (
                  <option key={carrier.carrierId} value={carrier.carrierId}>
                    {carrier.friendlyName} · ${carrier.balance.toFixed(2)}
                  </option>
                ))
              )}
            </select>
            {funds?.sharedWallet ? (
              <p className="text-xs text-muted-foreground">
                Shared wallet — funding any carrier refreshes the same available balance.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label>Amount (USD)</Label>
            <div className="flex flex-wrap gap-2">
              {ADD_FUND_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant={addFundsAmount === String(preset) ? "default" : "outline"}
                  onClick={() => setAddFundsAmount(String(preset))}
                  data-testid={`button-shipengine-add-funds-preset-${preset}`}
                >
                  ${preset}
                </Button>
              ))}
            </div>
            <Input
              inputMode="decimal"
              value={addFundsAmount}
              onChange={(event) => setAddFundsAmount(event.target.value.trim())}
              placeholder="25.00"
              data-testid="input-shipengine-add-funds-amount"
            />
            <p className="text-xs text-muted-foreground">Minimum $10 · max $5,000 per request.</p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setAddFundsOpen(false)}
            disabled={addFunds.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmitAddFunds}
            onClick={() => {
              const label = selectedAddFundsCarrier?.friendlyName || "carrier wallet";
              const amountLabel = Number.isFinite(addFundsAmountNum)
                ? formatMoney(addFundsAmountNum)
                : `$${addFundsAmount}`;
              if (
                !window.confirm(
                  `Add ${amountLabel} to ${label}? This charges your ShipStation payment method now.`,
                )
              ) {
                return;
              }
              addFunds.mutate();
            }}
            data-testid="button-shipengine-add-funds-confirm"
          >
            {addFunds.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Wallet className="mr-2 h-4 w-4" />
            )}
            Add {Number.isFinite(addFundsAmountNum) ? formatMoney(addFundsAmountNum) : "funds"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
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
