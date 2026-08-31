import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Beaker,
  CheckCircle2,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Scale,
  ShoppingBag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import type { ResinBottleEconomics, ResinInventorySnapshot, ResinReorderResponse } from "@shared/schema";

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function grams(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} g`;
}

function localDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "—";
}

export default function ResinInventoryPage() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: 'Resin inventory unlocked',
    successDescription: 'Active pour, bottle economics, and quoted-deal coverage.',
  });
  const [unitCost, setUnitCost] = useState("");
  const [addSealed, setAddSealed] = useState("1");
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);

  const inventory = useQuery<ResinInventorySnapshot & { ok: true }>({
    queryKey: ["/api/resin-inventory", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/resin-inventory", undefined, { headers });
      return (await response.json()) as ResinInventorySnapshot & { ok: true };
    },
  });

  const reorder = useQuery<ResinReorderResponse & { ok: true }>({
    queryKey: ["/api/resin-reorder", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/resin-reorder", undefined, { headers });
      return (await response.json()) as ResinReorderResponse & { ok: true };
    },
  });


  const product =
    inventory.data?.products.find((row) => row.id === selectedProductId) ??
    inventory.data?.products[0] ??
    null;

  const saveCost = useMutation({
    mutationFn: async () => {
      if (!product) throw new Error("Choose a resin product");
      const response = await apiRequest(
        "PUT",
        "/api/resin-inventory/products",
        {
          name: product.name,
          brand: product.brand,
          bottleMassG: product.bottleMassG,
          bottleVolumeMl: product.bottleVolumeMl,
          unitCostUsd: Number(unitCost) || 0,
          sealedCount: product.sealedCount,
          notes: product.notes,
        },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/resin-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/resin-reorder"] });
      toast({ title: "Bottle cost saved", description: "Economics will use this unit cost for open bottles going forward." });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not save bottle cost",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const adjust = useMutation({
    mutationFn: async (delta: number) => {
      if (!product) throw new Error("Choose a resin product");
      const response = await apiRequest(
        "POST",
        `/api/resin-inventory/products/${product.id}/adjust-sealed`,
        {
          delta,
          unitCostUsd: unitCost ? Number(unitCost) : undefined,
          notes: delta > 0 ? `Added ${delta} sealed bottle(s)` : `Removed ${Math.abs(delta)} sealed bottle(s)`,
        },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/resin-inventory"] });
      toast({ title: "Sealed stock updated" });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not update sealed stock",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const openBottle = useMutation({
    mutationFn: async () => {
      if (!product) throw new Error("Choose a resin product");
      const response = await apiRequest(
        "POST",
        "/api/resin-inventory/open-bottle",
        { productId: product.id, makeActive: true, notes: "" },
        { headers },
      );
      return (await response.json()) as { ok: true; message: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/resin-inventory"] });
      toast({ title: "Bottle opened", description: data.message });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not open a bottle",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 220),
        variant: "destructive",
      });
    },
  });

  const setActive = useMutation({
    mutationFn: async (bottleId: number) => {
      const response = await apiRequest(
        "POST",
        "/api/resin-inventory/set-active",
        { bottleId },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/resin-inventory"] });
      toast({ title: "Active pour bottle updated" });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not set active bottle",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const bottles = inventory.data?.bottles ?? [];
  const active = inventory.data?.activeBottle ?? null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Resin Inventory"
        subtitle="Track sealed bottles, the open pour bottle, grams used from attached plates, and rough $ per bottle."
        actions={
          <>
            {ownerCode ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => inventory.refetch()}
                disabled={inventory.isFetching}
                data-testid="button-refresh-resin-inventory"
              >
                {inventory.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Refresh
              </Button>
            ) : null}
          </>
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock resin inventory"
            description="Sealed stock starts from your on-hand bottles. Opening a bottle makes it the active pour source for attached plates."
            buttonLabel="Unlock resin inventory"
            testIdPrefix="resin-inventory"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : inventory.isLoading ? (
          <div className="space-y-5" data-testid="skeleton-resin-inventory">
            <Skeleton className="h-36 rounded-lg" />
            <Skeleton className="h-80 rounded-lg" />
          </div>
        ) : inventory.isError || !inventory.data ? (
          <Panel title="Resin inventory is not available" testId="panel-resin-inventory-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm text-muted-foreground">Refresh after checking your owner code and connection.</p>
                <Button className="mt-4" size="sm" onClick={() => inventory.refetch()}>
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          </Panel>
        ) : (
          <>
            <section className="metric-strip" aria-label="Inventory totals">
              <StatCard label="Sealed bottles" value={String(inventory.data.totals.sealedBottles)} hint={`Stock value ${money(inventory.data.totals.sealedValueUsd)}`} icon={Package} testId="metric-resin-sealed" />
              <StatCard label="Open bottles" value={String(inventory.data.totals.openBottles)} hint={active ? `Active: ${active.productName}` : "Open a bottle to start tracking pours"} icon={Beaker} testId="metric-resin-open" />
              <StatCard label="Resin used" value={grams(inventory.data.totals.resinUsedGrams)} hint={`Material cost ${money(inventory.data.totals.materialCostUsedUsd)}`} icon={Scale} testId="metric-resin-used" />
              <StatCard label="Deal revenue on bottles" value={money(inventory.data.totals.attributedDealRevenueUsd)} hint="Quoted amounts on deals that consumed these bottles" icon={CheckCircle2} testId="metric-resin-revenue" />
            </section>

            {reorder.data ? (
              <Panel
                title="What to buy next"
                description={`Burn rate over the last ${reorder.data.lookbackDays} days from plate consumption. Suggestions stay separate from HubSpot deal costs.`}
              >
                {reorder.data.buyNow.length === 0 && reorder.data.suggestions.every((item) => item.urgency === "ok") ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-resin-reorder-clear">
                    Stock looks fine for current burn — no urgent resin buys.
                  </p>
                ) : (
                  <ul className="space-y-2" data-testid="list-resin-reorder">
                    {reorder.data.suggestions
                      .filter((item) => item.urgency !== "ok" || item.suggestedBuyCount > 0)
                      .map((item) => (
                        <li
                          key={item.productId}
                          className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {item.name}{" "}
                              <span className="text-muted-foreground">· {item.brand}</span>
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{item.reason}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {item.gramsPerDay.toFixed(0)} g/day · sealed {item.sealedCount}
                              {item.daysOfStock != null && item.daysOfStock < 900
                                ? ` · ~${item.daysOfStock} days left`
                                : ""}
                            </p>
                          </div>
                          <StatusPill
                            tone={
                              item.urgency === "critical" ? "bad" : item.urgency === "soon" ? "warn" : "neutral"
                            }
                            icon={item.suggestedBuyCount > 0 ? ShoppingBag : Package}
                            label={
                              item.suggestedBuyCount > 0
                                ? `Buy ${item.suggestedBuyCount}`
                                : item.urgency
                            }
                          />
                        </li>
                      ))}
                  </ul>
                )}
              </Panel>
            ) : null}

            {product ? (
              <Panel
                title="Sealed stock"
                description="Your unopened bottles. Opening one moves it into the active pour bottle and starts gram tracking from attached plates."
              >
                <div className="space-y-4" data-testid="panel-resin-sealed">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-base font-semibold">{product.name}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {product.brand} · {grams(product.bottleMassG)} per bottle · {product.sealedCount} sealed
                      </p>
                    </div>
                    <StatusPill
                      tone={product.sealedCount > 0 ? "good" : "warn"}
                      icon={product.sealedCount > 0 ? Package : AlertTriangle}
                      label={`${product.sealedCount} sealed`}
                      testId="status-sealed-count"
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="resin-unit-cost">Cost per sealed bottle ($)</Label>
                      <Input
                        id="resin-unit-cost"
                        inputMode="decimal"
                        value={unitCost}
                        onChange={(event) => setUnitCost(event.target.value)}
                        placeholder="What you paid per bottle"
                        data-testid="input-resin-unit-cost"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="resin-add-sealed">Add sealed bottles</Label>
                      <Input
                        id="resin-add-sealed"
                        inputMode="numeric"
                        value={addSealed}
                        onChange={(event) => setAddSealed(event.target.value)}
                        data-testid="input-resin-add-sealed"
                      />
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <Button type="button" variant="outline" onClick={() => saveCost.mutate()} disabled={saveCost.isPending} data-testid="button-save-resin-cost">
                        Save cost
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => adjust.mutate(Math.max(1, Number(addSealed) || 1))}
                        disabled={adjust.isPending}
                        data-testid="button-add-sealed"
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Add stock
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() => openBottle.mutate()}
                      disabled={product.sealedCount < 1 || openBottle.isPending}
                      data-testid="button-open-resin-bottle"
                    >
                      {openBottle.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Beaker className="mr-2 h-4 w-4" />}
                      Open one bottle
                    </Button>
                    <p className="self-center text-xs text-muted-foreground">
                      Seeded with your 8 on-hand ELEGOO ABS-Like 3.0 bottles. Set the per-bottle cost, then open a bottle when you crack the seal.
                    </p>
                  </div>
                </div>
              </Panel>
            ) : null}

            {active ? (
              <Panel title="Active pour bottle" description="Attached plates with resin mass subtract from this bottle automatically.">
                <BottleCard bottle={active} onSetActive={undefined} />
              </Panel>
            ) : (
              <Panel title="Active pour bottle" description="No open bottle is active yet.">
                <p className="text-sm text-muted-foreground">
                  Open a sealed bottle to start tracking grams used when you attach CTB/ULTX plates.
                </p>
              </Panel>
            )}

            <Panel title="Bottle economics" description="Used grams, material cost, and quoted deal revenue tied to plates that consumed each bottle.">
              {bottles.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bottles opened yet.</p>
              ) : (
                <div className="space-y-4" data-testid="list-resin-bottles">
                  {bottles.map((bottle) => (
                    <BottleCard
                      key={bottle.bottleId}
                      bottle={bottle}
                      onSetActive={
                        bottle.status === "open" && !bottle.isActive
                          ? () => setActive.mutate(bottle.bottleId)
                          : undefined
                      }
                      busy={setActive.isPending}
                    />
                  ))}
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

function BottleCard({
  bottle,
  onSetActive,
  busy,
}: {
  bottle: ResinBottleEconomics;
  onSetActive?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-4" data-testid={`card-resin-bottle-${bottle.bottleId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{bottle.productName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Opened {localDate(bottle.openedAt)} · {bottle.plateCount} plate{bottle.plateCount === 1 ? "" : "s"} · {bottle.distinctOrders} order{bottle.distinctOrders === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {bottle.isActive ? (
            <StatusPill tone="good" icon={CheckCircle2} label="Active pour" testId={`status-bottle-active-${bottle.bottleId}`} />
          ) : (
            <StatusPill
              tone={bottle.status === "empty" ? "warn" : "neutral"}
              icon={Beaker}
              label={bottle.status === "empty" ? "Empty" : "Open"}
              testId={`status-bottle-${bottle.bottleId}`}
            />
          )}
          {onSetActive ? (
            <Button type="button" size="sm" variant="outline" onClick={onSetActive} disabled={busy} data-testid={`button-set-active-bottle-${bottle.bottleId}`}>
              Make active
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Used / remaining</p>
          <p className="mt-0.5 font-medium">{grams(bottle.usedMassG)} / {grams(bottle.remainingMassG)}</p>
          <p className="text-xs text-muted-foreground">{bottle.usedPercent}% of bottle</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Bottle cost</p>
          <p className="mt-0.5 font-medium">{money(bottle.unitCostUsd)}</p>
          <p className="text-xs text-muted-foreground">{money(bottle.costPerGram)}/g</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Material used</p>
          <p className="mt-0.5 font-medium">{money(bottle.materialCostUsedUsd)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Quoted deals − bottle cost</p>
          <p className="mt-0.5 font-medium">{money(bottle.roughContributionUsd)}</p>
          <p className="text-xs text-muted-foreground">Revenue {money(bottle.attributedDealRevenueUsd)}</p>
        </div>
      </div>

      {bottle.recentConsumptions.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-border/70 pt-3 text-xs">
          {bottle.recentConsumptions.map((row) => (
            <li key={row.id} className="flex flex-wrap justify-between gap-2">
              <span>{row.dealName || row.dealId} · {grams(row.resinMassG)}</span>
              <span className="text-muted-foreground">{row.dealAmount != null ? money(row.dealAmount) : "—"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
