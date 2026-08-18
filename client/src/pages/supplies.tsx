import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Boxes,
  CheckCircle2,
  FileUp,
  Loader2,
  PackagePlus,
  PlusCircle,
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
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { BooksBalancePanel } from "@/components/books-balance";
import { PageHeader } from "@/components/shell";
import { Panel, StatCard } from "@/components/primitives";
import {
  SUPPLY_CATEGORIES,
  SUPPLY_CATEGORY_LABELS,
  lineItemsForSupplyPurchase,
  type PerformanceResponse,
  type SupplyCategory,
  type SupplyPurchase,
  type SupplyPurchaseLineItem,
} from "@shared/schema";

type LineDraft = {
  itemName: string;
  quantity: string;
  lineAmount: string;
  category: "" | SupplyCategory;
};

type SupplyForm = {
  source: string;
  orderReference: string;
  totalAmount: string;
  purchasedAt: string;
  notes: string;
  lineItems: LineDraft[];
};

function localToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function emptyLine(): LineDraft {
  return { itemName: "", quantity: "1", lineAmount: "", category: "" };
}

function emptyForm(): SupplyForm {
  return {
    source: "",
    orderReference: "",
    totalAmount: "",
    purchasedAt: localToday(),
    notes: "",
    lineItems: [emptyLine()],
  };
}

const RECEIPT_ACCEPT =
  ".pdf,.txt,.csv,.tsv,.xlsx,.xls,.html,.htm,.jpg,.jpeg,.png,.webp,.gif,application/pdf,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/html,image/*";

function isSupportedReceiptFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    /\.(pdf|txt|text|csv|tsv|xlsx|xls|html|htm|jpe?g|png|webp|gif|bmp|tiff?)$/i.test(name) ||
    /^(application\/pdf|text\/(plain|csv|html)|application\/vnd\.(ms-excel|openxmlformats)|image\/)/i.test(
      file.type,
    )
  );
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

function toLineDrafts(items: SupplyPurchaseLineItem[] | undefined): LineDraft[] {
  if (!items || items.length === 0) return [emptyLine()];
  return items.map((item) => ({
    itemName: item.itemName || "",
    quantity: String(item.quantity || 1),
    lineAmount: item.lineAmount || "",
    category: item.category || "",
  }));
}

type ParsedInvoiceResponse = {
  ok: true;
  fields: {
    source: string;
    orderReference: string;
    itemName: string;
    category: SupplyCategory;
    quantity: number;
    totalAmount: string;
    purchasedAt: string;
    notes: string;
    lineItems: SupplyPurchaseLineItem[];
  };
  warnings: string[];
  pageCount: number;
};

export default function Supplies() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: 'Supply ledger unlocked',
    successDescription: 'Log purchases and keep the rolling spend books in sync.',
  });
  const [form, setForm] = useState<SupplyForm>(emptyForm);
  const [draggingInvoice, setDraggingInvoice] = useState(false);
  const invoiceInputRef = useRef<HTMLInputElement>(null);

  const supplies = useQuery<SupplyResponse>({
    queryKey: ["/api/supplies", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/supplies", undefined, { headers });
      return (await response.json()) as SupplyResponse;
    },
  });

  const books = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });


  const createPurchase = useMutation({
    mutationFn: async () => {
      const lineItems = form.lineItems
        .map((line) => ({
          itemName: line.itemName.trim(),
          quantity: Number(line.quantity) || 1,
          lineAmount: line.lineAmount.trim(),
          category: line.category || undefined,
        }))
        .filter((line) => line.itemName.length >= 2);

      const response = await apiRequest(
        "POST",
        "/api/supplies",
        {
          source: form.source,
          orderReference: form.orderReference,
          totalAmount: form.totalAmount,
          purchasedAt: form.purchasedAt,
          notes: form.notes,
          lineItems,
          itemName: lineItems[0]?.itemName ?? "",
          quantity: lineItems.reduce((sum, line) => sum + line.quantity, 0) || 1,
        },
        { headers },
      );
      return (await response.json()) as { ok: true; purchase: SupplyPurchase; summary: SupplySummary };
    },
    onSuccess: ({ purchase }) => {
      setForm(emptyForm());
      queryClient.invalidateQueries({ queryKey: ["/api/supplies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      void books.refetch();
      const lines = lineItemsForSupplyPurchase(purchase);
      toast({
        title: "Supply purchase saved",
        description:
          lines.length > 1
            ? `${lines.length} items logged · ${money(purchase.totalAmount)}.`
            : `${SUPPLY_CATEGORY_LABELS[purchase.category]}: ${purchase.itemName}.`,
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

  const parseInvoice = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const response = await apiRequest("POST", "/api/supplies/parse-invoice", body, { headers });
      return (await response.json()) as ParsedInvoiceResponse;
    },
    onSuccess: ({ fields, warnings }) => {
      const lineItems = toLineDrafts(
        fields.lineItems?.length
          ? fields.lineItems
          : fields.itemName
            ? [
                {
                  itemName: fields.itemName,
                  quantity: fields.quantity || 1,
                  lineAmount: "",
                  category: fields.category,
                },
              ]
            : [],
      );
      setForm({
        source: fields.source || "",
        orderReference: fields.orderReference || "",
        totalAmount: fields.totalAmount || "",
        purchasedAt: fields.purchasedAt || localToday(),
        notes: fields.notes || "",
        lineItems,
      });
      toast({
        title:
          lineItems.length === 0
            ? "Receipt partially filled in"
            : lineItems.length > 1
              ? "Receipt item breakdown filled in"
              : "Receipt fields filled in",
        description:
          warnings.length > 0
            ? `${warnings[0]} Review the form before saving.`
            : "Review nomenclature, cost, and vendor, then save the purchase.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Receipt could not be read",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const acceptInvoice = (file: File | undefined) => {
    if (!file) return;
    if (!isSupportedReceiptFile(file)) {
      toast({
        title: "Unsupported receipt file",
        description: "Use a PDF, CSV, Excel, text, HTML, or photo of the receipt.",
        variant: "destructive",
      });
      return;
    }
    parseInvoice.mutate(file);
  };

  const updateLine = (index: number, patch: Partial<LineDraft>) => {
    setForm((current) => ({
      ...current,
      lineItems: current.lineItems.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  };

  const submit = () => {
    const named = form.lineItems.filter((line) => line.itemName.trim().length >= 2);
    if (named.length === 0) {
      toast({
        title: "Add at least one item",
        description: "Enter what you purchased before saving it.",
        variant: "destructive",
      });
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
        subtitle="Drop a receipt, confirm the items, then review what you’ve spent."
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
          </>
        }
      />

      <div className="page-stack">
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
            <section
              className="grid gap-3 sm:grid-cols-2"
              aria-label="Supply spend summary"
              data-testid="summary-supplies-status"
            >
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

            <Panel
              title="1. Log a purchase"
              description="Start here — drop a receipt or invoice, then confirm items and total before saving."
            >
              <div className="mb-5 space-y-2">
                <input
                  ref={invoiceInputRef}
                  type="file"
                  accept={RECEIPT_ACCEPT}
                  className="sr-only"
                  onChange={(event) => {
                    acceptInvoice(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                  data-testid="input-supply-invoice"
                />
                <button
                  type="button"
                  onClick={() => invoiceInputRef.current?.click()}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDraggingInvoice(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDraggingInvoice(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDraggingInvoice(false);
                    acceptInvoice(event.dataTransfer.files?.[0]);
                  }}
                  disabled={parseInvoice.isPending}
                  className={`flex min-h-32 w-full flex-col items-center justify-center rounded-md border border-dashed px-5 text-center transition-colors ${
                    draggingInvoice ? "border-primary bg-primary/10" : "border-border bg-muted/35 hover:bg-muted/60"
                  }`}
                  data-testid="dropzone-supply-invoice"
                >
                  {parseInvoice.isPending ? (
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  ) : (
                    <FileUp className="h-5 w-5 text-primary" />
                  )}
                  <span className="mt-2 text-sm font-medium">
                    {parseInvoice.isPending ? "Reading receipt…" : "Drop a receipt or invoice here"}
                  </span>
                  <span className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                    PDF, CSV, Excel, text, HTML, photo, or screenshot. Reads item names, quantities, cost, and vendor. Nothing is saved until you confirm.
                  </span>
                </button>
              </div>

              <form
                className="grid gap-4 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <div className="space-y-3 sm:col-span-2" data-testid="panel-supply-line-items">
                  <div>
                    <p className="text-sm font-medium">Items bought</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Add every SKU from the receipt. Line amounts are optional; the receipt total below is what counts for spend.
                    </p>
                  </div>
                  {form.lineItems.map((line, index) => (
                    <div
                      key={index}
                      className="grid gap-3 rounded-md border border-border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1.5fr)_5.5rem_6.5rem_minmax(8rem,0.8fr)_auto]"
                      data-testid={`row-supply-line-${index}`}
                    >
                      <div className="space-y-1.5">
                        <Label htmlFor={`supply-line-name-${index}`}>
                          Item {index + 1}
                          <span className="text-primary"> *</span>
                        </Label>
                        <Input
                          id={`supply-line-name-${index}`}
                          value={line.itemName}
                          onChange={(event) => updateLine(index, { itemName: event.target.value })}
                          placeholder="Elegoo ABS-like resin, 2 kg"
                          data-testid={`input-supply-line-name-${index}`}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`supply-line-qty-${index}`}>Qty</Label>
                        <Input
                          id={`supply-line-qty-${index}`}
                          type="number"
                          min="1"
                          value={line.quantity}
                          onChange={(event) => updateLine(index, { quantity: event.target.value })}
                          data-testid={`input-supply-line-qty-${index}`}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`supply-line-amount-${index}`}>Line $</Label>
                        <Input
                          id={`supply-line-amount-${index}`}
                          inputMode="decimal"
                          value={line.lineAmount}
                          onChange={(event) => updateLine(index, { lineAmount: event.target.value })}
                          placeholder="Optional"
                          data-testid={`input-supply-line-amount-${index}`}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`supply-line-category-${index}`}>Category</Label>
                        <select
                          id={`supply-line-category-${index}`}
                          value={line.category}
                          onChange={(event) =>
                            updateLine(index, { category: event.target.value as LineDraft["category"] })
                          }
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          data-testid={`select-supply-line-category-${index}`}
                        >
                          <option value="">Auto</option>
                          {SUPPLY_CATEGORIES.map((category) => (
                            <option key={category} value={category}>
                              {SUPPLY_CATEGORY_LABELS[category]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={form.lineItems.length <= 1}
                          onClick={() =>
                            setForm((current) => ({
                              ...current,
                              lineItems: current.lineItems.filter((_, i) => i !== index),
                            }))
                          }
                          data-testid={`button-remove-supply-line-${index}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setForm((current) => ({ ...current, lineItems: [...current.lineItems, emptyLine()] }))}
                    data-testid="button-add-supply-line"
                  >
                    <PlusCircle className="mr-2 h-3.5 w-3.5" />
                    Add another item
                  </Button>
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
                  <Label htmlFor="supply-source">Vendor / source</Label>
                  <Input
                    id="supply-source"
                    value={form.source}
                    onChange={(event) => setForm((current) => ({ ...current, source: event.target.value }))}
                    placeholder="Amazon, Uline, ELEGOO, Home Depot…"
                    data-testid="input-supply-source"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="supply-reference">Order / invoice number</Label>
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
                    Creates a local supply record only — it does not change HubSpot deals or order gross profit by itself.
                  </p>
                  <Button type="submit" disabled={createPurchase.isPending} data-testid="button-save-supply">
                    {createPurchase.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackagePlus className="mr-2 h-4 w-4" />}
                    Save purchase
                  </Button>
                </div>
              </form>
            </Panel>

            <section className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(16rem,0.65fr)]">
              <Panel title="2. Recent purchases" description="Receipts you’ve already logged.">
                {supplies.data.purchases.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead className="border-b border-border text-xs text-muted-foreground">
                        <tr>
                          <th className="px-2 py-2 font-medium">Purchase</th>
                          <th className="px-2 py-2 font-medium">Items</th>
                          <th className="px-2 py-2 font-medium">Reference</th>
                          <th className="px-2 py-2 text-right font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {supplies.data.purchases.map((purchase) => {
                          const lines = lineItemsForSupplyPurchase(purchase);
                          return (
                            <tr key={purchase.id} className="border-b border-border/70 last:border-0" data-testid={`row-supply-purchase-${purchase.id}`}>
                              <td className="px-2 py-3 align-top">
                                <span className="block font-medium">
                                  {lines.length > 1 ? `${lines.length} items` : lines[0]?.itemName || purchase.itemName}
                                </span>
                                <span className="mt-0.5 block text-xs text-muted-foreground">
                                  {purchase.source} · {displayDate(purchase.purchasedAt)}
                                </span>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <ul className="space-y-1.5" data-testid={`list-supply-items-${purchase.id}`}>
                                  {lines.map((line, index) => (
                                    <li key={`${purchase.id}-${index}`} className="text-xs leading-5">
                                      <span className="font-medium text-foreground">{line.itemName}</span>
                                      <span className="mt-0.5 block text-muted-foreground">
                                        Qty {line.quantity}
                                        {line.lineAmount ? ` · ${money(line.lineAmount)}` : ""}
                                        {" · "}
                                        {SUPPLY_CATEGORY_LABELS[line.category]}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </td>
                              <td className="px-2 py-3 align-top text-xs text-muted-foreground">{purchase.orderReference || "—"}</td>
                              <td className="numeric px-2 py-3 align-top text-right font-medium">{money(purchase.totalAmount)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="rounded-md bg-muted/50 p-4" data-testid="empty-supply-purchases">
                    <p className="text-sm font-medium">No supply purchases yet.</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Drop a receipt above after your next business purchase. Your ledger fills in from there.
                    </p>
                  </div>
                )}
              </Panel>

              <Panel title="Spend by category" description="How logged receipts break down.">
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
                    <p className="text-sm font-medium">Categories appear after you log receipts.</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Resin, gloves, packaging, and maintenance will show here automatically.
                    </p>
                  </div>
                )}
              </Panel>
            </section>

            {books.data?.books ? (
              <BooksBalancePanel books={books.data.books} />
            ) : books.isLoading ? (
              <Skeleton className="h-[22rem] rounded-lg" data-testid="skeleton-books-balance" />
            ) : null}

            <section className="flex items-start gap-3 rounded-lg border border-border bg-muted/35 p-4" data-testid="note-supplies-no-double-count">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-chart-4" />
              <p className="text-xs leading-5 text-muted-foreground">
                Supply purchases are a management view, not a replacement for order-level costing. Enter actual material, labor, packaging, and shipping costs from Queue → Ops so HubSpot gross profit stays accurate.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
