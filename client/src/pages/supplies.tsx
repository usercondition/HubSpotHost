import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Boxes,
  CheckCircle2,
  Loader2,
  PackagePlus,
  ReceiptText,
  RefreshCw,
  ShoppingBag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession } from "@/hooks/use-owner-session";
import { PageHeader, ThemeToggle } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import {
  SUPPLY_CATEGORIES,
  SUPPLY_CATEGORY_LABELS,
  type SupplyCategory,
  type SupplyPurchase,
} from "@shared/schema";

type SupplyForm = {
  source: string;
  orderReference: string;
  itemName: string;
  category: "" | SupplyCategory;
  quantity: string;
  totalAmount: string;
  purchasedAt: string;
  notes: string;
};

function localToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function emptyForm(): SupplyForm {
  return {
    source: "Amazon",
    orderReference: "",
    itemName: "",
    category: "",
    quantity: "1",
    totalAmount: "",
    purchasedAt: localToday(),
    notes: "",
  };
}

interface SupplySummary {
  periodDays: number;
  total: number;
  purchases: number;
  byCategory: Array<{
    category: SupplyCategory;
    label: string;
    total: number;
    count: number;
  }>;
}

interface SupplyResponse {
  ok: true;
  purchases: SupplyPurchase[];
  summary: SupplySummary;
}

function money(value: number | string): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  return (Number.isFinite(parsed) ? parsed : 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function displayDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function Supplies() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers, unlock: setSessionUnlocked } = useOwnerSession();
  const [form, setForm] = useState<SupplyForm>(emptyForm);

  const supplies = useQuery<SupplyResponse>({
    queryKey: ["/api/supplies", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/supplies", undefined, { headers });
      return (await response.json()) as SupplyResponse;
    },
  });

  const unlock = useMutation({
    mutationFn: async (code: string) => {
      const response = await apiRequest("GET", "/api/supplies", undefined, {
        headers: { "x-paid-order-access-code": code },
      });
      return { code, data: (await response.json()) as SupplyResponse };
    },
    onSuccess: ({ code, data }) => {
      setSessionUnlocked(code);
      toast({
        title: "Supply ledger unlocked",
        description: `${data.summary.purchases} purchase${data.summary.purchases === 1 ? "" : "s"} logged in the last ${data.summary.periodDays} days.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "That owner code was not accepted",
        description: error.message.startsWith("401")
          ? "Check the code and try again. Nothing was unlocked."
          : "The supply ledger could not be reached. Try again shortly.",
        variant: "destructive",
      });
    },
  });

  const createPurchase = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        "/api/supplies",
        {
          ...form,
          category: form.category || undefined,
          quantity: Number(form.quantity) || 1,
        },
        { headers },
      );
      return (await response.json()) as { ok: true; purchase: SupplyPurchase; summary: SupplySummary };
    },
    onSuccess: ({ purchase }) => {
      setForm(emptyForm());
      queryClient.invalidateQueries({ queryKey: ["/api/supplies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      toast({
        title: "Supply purchase saved",
        description: `${SUPPLY_CATEGORY_LABELS[purchase.category]}: ${purchase.itemName}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Purchase was not saved",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 180),
        variant: "destructive",
      });
    },
  });

  const submit = () => {
    if (form.itemName.trim().length < 2) {
      toast({ title: "Add the item name", description: "Enter what you purchased before saving it.", variant: "destructive" });
      return;
    }
    if (!form.totalAmount.trim()) {
      toast({ title: "Add the total paid", description: "Enter the receipt total before saving it.", variant: "destructive" });
      return;
    }
    createPurchase.mutate();
  };

  const summary = supplies.data?.summary;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Supply spend"
        subtitle="A simple receipt ledger for the business purchases that support your print operation."
        actions={
          <>
            {ownerCode ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => supplies.refetch()}
                disabled={supplies.isFetching}
                data-testid="button-refresh-supplies"
              >
                {supplies.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Refresh
              </Button>
            ) : null}
            <ThemeToggle />
          </>
        }
      />

      <div className="space-y-5 px-4 py-5 md:px-6">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock supply tracking"
            description="Log Amazon and other purchases against your print operations. The owner code stays only in this browser tab."
            buttonLabel="Unlock supplies"
            testIdPrefix="supplies"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : supplies.isLoading ? (
          <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]" data-testid="skeleton-supplies">
            <Skeleton className="h-[36rem] rounded-lg" />
            <Skeleton className="h-[20rem] rounded-lg" />
          </div>
        ) : supplies.isError || !supplies.data ? (
          <section className="rounded-lg border border-destructive/35 bg-card p-5" data-testid="panel-supplies-error">
            <p className="text-sm font-medium">The supply ledger is not available right now.</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Refresh after checking your owner code and connection.</p>
            <Button className="mt-4" size="sm" onClick={() => supplies.refetch()} data-testid="button-retry-supplies">
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Try again
            </Button>
          </section>
        ) : (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3" data-testid="summary-supplies-status">
              <div>
                <p className="rule-label">Regular Amazon account workflow</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Copy a receipt total here after a business purchase. The category is suggested automatically unless you choose a different one.
                </p>
              </div>
              <StatusPill
                tone="neutral"
                icon={ReceiptText}
                label={`${supplies.data.summary.purchases} logged in ${supplies.data.summary.periodDays} days`}
                testId="status-supplies"
              />
            </section>

            <section className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
              <Panel title="Log a supply purchase" description="Use the final total from your Amazon order confirmation or receipt.">
                <form
                  className="grid gap-4 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                  }}
                >
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="supply-item-name">Item purchased</Label>
                    <Input
                      id="supply-item-name"
                      value={form.itemName}
                      onChange={(event) => setForm((current) => ({ ...current, itemName: event.target.value }))}
                      placeholder="Example: Elegoo ABS-like resin, 2 kg"
                      data-testid="input-supply-item-name"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="supply-total">Total paid</Label>
                    <Input
                      id="supply-total"
                      inputMode="decimal"
                      value={form.totalAmount}
                      onChange={(event) => setForm((current) => ({ ...current, totalAmount: event.target.value }))}
                      placeholder="38.99"
                      data-testid="input-supply-total"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="supply-date">Purchase date</Label>
                    <Input
                      id="supply-date"
                      type="date"
                      value={form.purchasedAt}
                      onChange={(event) => setForm((current) => ({ ...current, purchasedAt: event.target.value }))}
                      data-testid="input-supply-date"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="supply-quantity">Quantity</Label>
                    <Input
                      id="supply-quantity"
                      type="number"
                      min="1"
                      value={form.quantity}
                      onChange={(event) => setForm((current) => ({ ...current, quantity: event.target.value }))}
                      data-testid="input-supply-quantity"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="supply-category">Category</Label>
                    <select
                      id="supply-category"
                      value={form.category}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, category: event.target.value as SupplyForm["category"] }))
                      }
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      data-testid="select-supply-category"
                    >
                      <option value="">Auto-categorize from item name</option>
                      {SUPPLY_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {SUPPLY_CATEGORY_LABELS[category]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="supply-source">Source</Label>
                    <Input
                      id="supply-source"
                      value={form.source}
                      onChange={(event) => setForm((current) => ({ ...current, source: event.target.value }))}
                      placeholder="Amazon"
                      data-testid="input-supply-source"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="supply-reference">Amazon order number</Label>
                    <Input
                      id="supply-reference"
                      value={form.orderReference}
                      onChange={(event) => setForm((current) => ({ ...current, orderReference: event.target.value }))}
                      placeholder="Optional"
                      data-testid="input-supply-reference"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="supply-notes">Notes</Label>
                    <Textarea
                      id="supply-notes"
                      value={form.notes}
                      onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                      placeholder="Optional: brand, printer it supports, or why you bought it"
                      className="min-h-20"
                      data-testid="input-supply-notes"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
                    <p className="max-w-md text-xs leading-5 text-muted-foreground">
                      This creates a local supply record. It does not change a HubSpot deal or reduce gross profit by itself.
                    </p>
                    <Button type="submit" disabled={createPurchase.isPending} data-testid="button-save-supply">
                      {createPurchase.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackagePlus className="mr-2 h-4 w-4" />}
                      Save purchase
                    </Button>
                  </div>
                </form>
              </Panel>

              <div className="space-y-5">
                <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <StatCard
                    label="Supply spend"
                    value={money(summary?.total ?? 0)}
                    hint={`Last ${summary?.periodDays ?? 30} days`}
                    icon={ShoppingBag}
                    testId="metric-supplies-total"
                  />
                  <StatCard
                    label="Receipts logged"
                    value={String(summary?.purchases ?? 0)}
                    hint="One record per business purchase"
                    icon={Boxes}
                    testId="metric-supplies-count"
                  />
                </section>

                <Panel title="Spend by category" description="A quick view of what is supporting production.">
                  {summary && summary.byCategory.length > 0 ? (
                    <div className="space-y-2">
                      {summary.byCategory.map((bucket) => (
                        <div
                          key={bucket.category}
                          className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2.5"
                          data-testid={`row-supplies-category-${bucket.category}`}
                        >
                          <span className="text-sm">{bucket.label}</span>
                          <span className="numeric text-sm font-medium">
                            {money(bucket.total)} <span className="text-xs font-normal text-muted-foreground">({bucket.count})</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-md bg-muted/50 p-4" data-testid="empty-supplies-categories">
                      <p className="text-sm font-medium">Your category view will build as you log receipts.</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Start with resin, gloves, packaging, or any maintenance purchase from your next order.
                      </p>
                    </div>
                  )}
                </Panel>
              </div>
            </section>

            <Panel title="Recent supply purchases" description="The most recent receipt records in your command center.">
              {supplies.data.purchases.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="border-b border-border text-xs text-muted-foreground">
                      <tr>
                        <th className="px-2 py-2 font-medium">Purchase</th>
                        <th className="px-2 py-2 font-medium">Category</th>
                        <th className="px-2 py-2 font-medium">Reference</th>
                        <th className="px-2 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {supplies.data.purchases.map((purchase) => (
                        <tr key={purchase.id} className="border-b border-border/70 last:border-0" data-testid={`row-supply-purchase-${purchase.id}`}>
                          <td className="px-2 py-3">
                            <span className="block font-medium">{purchase.itemName}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {purchase.source} · {displayDate(purchase.purchasedAt)} · Qty {purchase.quantity}
                            </span>
                          </td>
                          <td className="px-2 py-3 text-xs text-muted-foreground">{SUPPLY_CATEGORY_LABELS[purchase.category]}</td>
                          <td className="px-2 py-3 text-xs text-muted-foreground">{purchase.orderReference || "—"}</td>
                          <td className="numeric px-2 py-3 text-right font-medium">{money(purchase.totalAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-md bg-muted/50 p-4" data-testid="empty-supply-purchases">
                  <p className="text-sm font-medium">No supply purchases yet.</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Use the form above after your next business purchase. The dashboard will begin showing your purchasing pattern automatically.
                  </p>
                </div>
              )}
            </Panel>

            <section className="flex items-start gap-3 rounded-lg border border-border bg-muted/35 p-4" data-testid="note-supplies-no-double-count">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-chart-4" />
              <p className="text-xs leading-5 text-muted-foreground">
                Supply purchases are a management view, not a replacement for order-level costing. Keep recording actual material, labor, packaging, and shipping costs on the related HubSpot deal so gross profit remains accurate.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
