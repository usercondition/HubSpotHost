import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  Ban,
  KeyRound,
  Link2,
  Loader2,
  PlusCircle,
  RefreshCw,
  ShieldCheck,
  Unlock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ORDER_INTAKE_STATUSES,
  ORDER_INTAKE_STATUS_LABELS,
  intakeLineExtendedAmount,
  lineItemsForIntake,
  parseHubSpotDealsJson,
  summarizeIntakeLineItems,
  type OrderIntakeLink,
  type OrderIntakeStatus,
} from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { printsDealHref } from "@/lib/workflow";

/** Owner-side rows never carry the token hash. */
type QueueLink = Omit<OrderIntakeLink, "tokenHash">;

interface QueueResponse {
  ok: true;
  counts: Record<OrderIntakeStatus, number>;
  links: QueueLink[];
}

const STATUS_TONE: Record<OrderIntakeStatus, "neutral" | "good" | "warn" | "bad"> = {
  awaiting_client: "neutral",
  pending_review: "warn",
  created: "good",
  expired: "bad",
};

const STATUS_ICON = {
  awaiting_client: Clock3,
  pending_review: AlertTriangle,
  created: CheckCircle2,
  expired: Ban,
} as const;

const EMPTY_FORM = {
  paymentMethod: "",
  paymentReference: "",
  buyerNameHint: "",
  buyerUsernameHint: "",
  ownerNotes: "",
  expiryDays: "14",
};

type LineDraft = { description: string; amount: string; quantity: string };

function emptyLine(): LineDraft {
  return { description: "", amount: "", quantity: "1" };
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}


function expiryCue(expiresAt: string): { label: string; urgent: boolean } {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return { label: `expires ${formatDate(expiresAt)}`, urgent: false };
  if (ms < 0) return { label: "Expired", urgent: true };
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 48) {
    const label = hours <= 24 ? (hours <= 1 ? "Expires within an hour" : `Expires in ${hours}h`) : "Expires within 2 days";
    return { label, urgent: true };
  }
  return { label: `expires ${formatDate(expiresAt)}`, urgent: false };
}

function marketplaceReminderText(link: {
  confirmedItem?: string | null;
  itemDescription: string;
  agreedAmount: string;
  expiresAt: string;
}): string {
  const item = (link.confirmedItem || link.itemDescription || "your order").trim();
  return `Hi — please fill in this short order form for ${item} ($${link.agreedAmount}) before it expires (${formatDate(link.expiresAt)}). Thanks!`;
}

/** Builds the buyer URL from the page's own location — no secrets in source. */
function absoluteClientUrl(path: string): string {
  const { origin, pathname } = window.location;
  const base = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname.replace(/\/index\.html$/, "");
  return `${origin}${base}${path}`;
}

/**
 * Owner console for one-time client order links.
 *
 * PRODUCTION HARDENING: access is gated by a single shared owner access code
 * that the operator types in here and that is held in React state only — never
 * in the bundle, browser storage, or cookies. Replace it with real per-user
 * authentication before this is used by more than one person.
 */
export default function OrderLinks() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: 'Intake unlocked',
    successDescription: 'Create buyer links and approve paid orders into HubSpot.',
  });
  const [tab, setTab] = useState<OrderIntakeStatus>("pending_review");
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [lineItems, setLineItems] = useState<LineDraft[]>([emptyLine()]);
  const [newLinkUrl, setNewLinkUrl] = useState<string | null>(null);
  const [newLinkLabel, setNewLinkLabel] = useState("");
  const [copied, setCopied] = useState(false);
  const [reviewId, setReviewId] = useState<number | null>(null);

  const queue = useQuery<QueueResponse>({
    queryKey: ["/api/order-links", tab],
    enabled: isUnlocked,
    // Buyers submit from their own browser, so poll to keep the queue current.
    refetchInterval: 15000,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/order-links?status=${tab}`, undefined, { headers });
      return (await res.json()) as QueueResponse;
    },
  });

  const counts = queue.data?.counts;


  const createLink = useMutation({
    mutationFn: async (payload: {
      lineItems: Array<{ description: string; amount: string; quantity: number }>;
      paymentMethod: string;
      paymentReference: string;
      buyerNameHint: string;
      buyerUsernameHint: string;
      ownerNotes: string;
      expiryDays: number;
    }) => {
      const res = await apiRequest("POST", "/api/order-links", payload, { headers });
      return (await res.json()) as { ok: true; path: string; link: QueueLink };
    },
    onSuccess: ({ path, link }) => {
      setNewLinkUrl(absoluteClientUrl(path));
      setNewLinkLabel(link.internalLabel);
      setCopied(false);
      setForm({ ...EMPTY_FORM });
      setLineItems([emptyLine()]);
      setTab("awaiting_client");
      queryClient.invalidateQueries({ queryKey: ["/api/order-links"] });
      toast({
        title: "Client link ready",
        description: "Copy it now and send it in Marketplace. It is shown only once.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Link was not created",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const expireLink = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/order-links/${id}/expire`, {}, { headers });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/order-links"] });
      toast({ title: "Link expired", description: "That link can no longer be used by a buyer." });
    },
    onError: (error: Error) =>
      toast({
        title: "Could not expire that link",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      }),
  });

  const copyLink = async () => {
    if (!newLinkUrl) return;
    try {
      await navigator.clipboard.writeText(newLinkUrl);
      setCopied(true);
      toast({ title: "Link copied", description: "Paste it into the Marketplace conversation." });
    } catch {
      toast({
        title: "Copy was blocked by the browser",
        description: "Select the link text below and copy it manually.",
        variant: "destructive",
      });
    }
  };

  const submitCreate = () => {
    const cleaned = lineItems
      .map((line) => ({
        description: line.description.trim(),
        amount: line.amount.trim(),
        quantity: Math.max(1, Math.min(999, Number(line.quantity) || 1)),
      }))
      .filter((line) => line.description.length >= 2 || line.amount.length > 0);

    if (cleaned.length === 0 || cleaned.some((line) => line.description.length < 2)) {
      toast({
        title: "Add at least one item",
        description: "Each Print Order needs a short item description.",
        variant: "destructive",
      });
      return;
    }
    for (const line of cleaned) {
      const amount = Number(line.amount.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(amount) || amount < 0) {
        toast({
          title: "Check each item amount",
          description: "Every line needs a unit price of zero or more (use 0 for free add-ons).",
          variant: "destructive",
        });
        return;
      }
    }

    createLink.mutate({
      lineItems: cleaned,
      paymentMethod: form.paymentMethod,
      paymentReference: form.paymentReference,
      buyerNameHint: form.buyerNameHint,
      buyerUsernameHint: form.buyerUsernameHint,
      ownerNotes: form.ownerNotes,
      expiryDays: Number(form.expiryDays) || 14,
    });
  };

  const set = (key: keyof typeof EMPTY_FORM, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const lineTotal = summarizeIntakeLineItems(
    lineItems
      .filter((line) => {
        if (line.description.trim().length < 2 || !line.amount.trim()) return false;
        const amount = Number(line.amount.replace(/[$,\s]/g, ""));
        return Number.isFinite(amount) && amount >= 0;
      })
      .map((line) => ({
        description: line.description.trim(),
        amount: line.amount.trim(),
        quantity: Math.max(1, Number(line.quantity) || 1),
      })),
  ).agreedAmount;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Paid order intake"
        subtitle="Create one buyer link, review their details, then approve the order into HubSpot."
        actions={
          <>
            <StatusPill
              tone={isUnlocked ? "good" : "neutral"}
              icon={isUnlocked ? Unlock : KeyRound}
              label={isUnlocked ? "Owner tools unlocked" : "Locked"}
              testId="status-owner-lock"
            />
          </>
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock Intake"
            description="Create buyer links and approve paid orders into HubSpot. Buyers never need this code."
            buttonLabel="Unlock Intake"
            testIdPrefix="intake"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : (
          <>
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(19rem,0.85fr)]">
              <Panel
                title="Create an order form link"
                description="Add one or more items. Approval creates one HubSpot Contact and one Print Order deal per item."
              >
                <p className="mb-3 text-xs text-muted-foreground">
                  Already have the buyer’s details?{" "}
                  <Link href="/paid-orders" className="hs-link font-medium" data-testid="link-intake-to-manual">
                    Use Manual entry
                  </Link>
                  .
                </p>
                <div className="space-y-3" data-testid="panel-intake-line-items">
                  {lineItems.map((line, index) => (
                    <div
                      key={index}
                      className="grid gap-3 rounded-md border border-border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1.4fr)_7rem_5rem_auto]"
                      data-testid={`row-line-item-${index}`}
                    >
                      <div className="space-y-1.5">
                        <Label htmlFor={`line-desc-${index}`}>
                          Item {index + 1}
                          <span className="text-primary"> *</span>
                        </Label>
                        <Input
                          id={`line-desc-${index}`}
                          value={line.description}
                          onChange={(event) =>
                            setLineItems((current) =>
                              current.map((row, i) =>
                                i === index ? { ...row, description: event.target.value } : row,
                              ),
                            )
                          }
                          placeholder="Acastus Knight Porphyrion"
                          data-testid={`input-line-description-${index}`}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`line-amount-${index}`}>Unit price *</Label>
                        <Input
                          id={`line-amount-${index}`}
                          inputMode="decimal"
                          value={line.amount}
                          onChange={(event) =>
                            setLineItems((current) =>
                              current.map((row, i) =>
                                i === index ? { ...row, amount: event.target.value } : row,
                              ),
                            )
                          }
                          placeholder="44.99"
                          data-testid={`input-line-amount-${index}`}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`line-qty-${index}`}>Qty</Label>
                        <Input
                          id={`line-qty-${index}`}
                          inputMode="numeric"
                          value={line.quantity}
                          onChange={(event) =>
                            setLineItems((current) =>
                              current.map((row, i) =>
                                i === index ? { ...row, quantity: event.target.value } : row,
                              ),
                            )
                          }
                          data-testid={`input-line-quantity-${index}`}
                        />
                      </div>
                      <div className="flex items-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={lineItems.length <= 1}
                          onClick={() =>
                            setLineItems((current) => current.filter((_, i) => i !== index))
                          }
                          data-testid={`button-remove-line-${index}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setLineItems((current) => [...current, emptyLine()])}
                      data-testid="button-add-line-item"
                    >
                      <PlusCircle className="mr-2 h-3.5 w-3.5" />
                      Add another item
                    </Button>
                    <p className="text-sm text-muted-foreground" data-testid="text-line-items-total">
                      Order total: <span className="font-medium text-foreground numeric">${lineTotal}</span>
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground sm:col-span-2">
                    <span className="font-medium text-foreground">Order reference: </span>
                    generated automatically when you create the link. Same client email keeps one Contact across every item deal.
                  </div>
                  <TextField
                    id="payment-method"
                    label="Payment method (optional)"
                    value={form.paymentMethod}
                    onChange={(v) => set("paymentMethod", v)}
                  />
                  <TextField
                    id="payment-reference"
                    label="Payment reference (optional)"
                    value={form.paymentReference}
                    onChange={(v) => set("paymentReference", v)}
                  />
                  <TextField
                    id="buyer-name-hint"
                    label="Marketplace buyer name (optional)"
                    value={form.buyerNameHint}
                    onChange={(v) => set("buyerNameHint", v)}
                  />
                  <TextField
                    id="buyer-username-hint"
                    label="Marketplace username (optional)"
                    value={form.buyerUsernameHint}
                    onChange={(v) => set("buyerUsernameHint", v)}
                  />
                  <TextField
                    id="expiry-days"
                    label="Link expires in (days)"
                    value={form.expiryDays}
                    onChange={(v) => set("expiryDays", v)}
                    inputMode="decimal"
                    hint="14 days is a good default."
                  />
                  <div className="sm:col-span-2 space-y-1.5">
                    <Label htmlFor="owner-notes">Private notes (optional)</Label>
                    <Textarea
                      id="owner-notes"
                      className="min-h-16 resize-y text-sm"
                      value={form.ownerNotes}
                      onChange={(event) => set("ownerNotes", event.target.value)}
                      data-testid="input-owner-notes"
                    />
                  </div>
                </div>

                <Button
                  type="button"
                  className="mt-4 w-full"
                  onClick={submitCreate}
                  disabled={createLink.isPending}
                  data-testid="button-create-order-link"
                >
                  {createLink.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="mr-2 h-4 w-4" />
                  )}
                  Create order form link
                </Button>

                {newLinkUrl && (
                  <div
                    className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3"
                    data-testid="panel-new-link"
                  >
                    <p className="rule-label">Link for {newLinkLabel || "this order"}</p>
                    <p
                      className="numeric mt-2 break-all rounded border border-border bg-background/70 p-2 text-xs"
                      data-testid="text-new-link-url"
                    >
                      {newLinkUrl}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" onClick={copyLink} data-testid="button-copy-link">
                        {copied ? <Check className="mr-2 h-4 w-4" /> : <ClipboardCopy className="mr-2 h-4 w-4" />}
                        {copied ? "Copied" : "Copy link"}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        Shown once. Paste this order form link to your buyer.
                      </span>
                    </div>
                  </div>
                )}
              </Panel>

              <Panel title="How the link works" description="Nothing reaches HubSpot until you approve.">
                <ol className="space-y-4">
                  {[
                    {
                      title: "Send the link",
                      text: "Paste it into the Marketplace conversation after payment clears.",
                    },
                    {
                      title: "Buyer fills in details",
                      text: "Name, contact, shipping, item confirmation, quantity, notes. One submission per link.",
                    },
                    {
                      title: "You review privately",
                      text: "The submission appears under Pending review. Correct anything the buyer typed loosely.",
                    },
                    {
                      title: "You approve",
                      text: "Confirming verified payment enables the HubSpot write: Contact plus a Print Orders deal in Deposit Received.",
                    },
                  ].map((step, index) => (
                    <li key={step.title} className="flex gap-3" data-testid={`step-order-link-${index + 1}`}>
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-primary">
                        {index + 1}
                      </span>
                      <div>
                        <p className="text-sm font-medium">{step.title}</p>
                        <p className="mt-0.5 text-sm text-muted-foreground">{step.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="mt-5 flex gap-2 rounded-md border border-border bg-muted/35 p-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    A buyer submission writes only to this app's private queue. Expired, used, or
                    unknown links reveal no order information.
                  </p>
                </div>
              </Panel>
            </section>

            <Panel
              title="Review queue"
              description="Submitted details wait here until you approve or expire them."
              actions={
                <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Queue status">
                  {ORDER_INTAKE_STATUSES.map((status) => (
                    <button
                      key={status}
                      type="button"
                      role="tab"
                      aria-selected={tab === status}
                      onClick={() => setTab(status)}
                      data-testid={`tab-queue-${status}`}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                        tab === status
                          ? "border-primary/45 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {ORDER_INTAKE_STATUS_LABELS[status]}
                      {counts ? ` (${counts[status]})` : ""}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => queue.refetch()}
                    data-testid="button-refresh-queue"
                    className="ml-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <RefreshCw
                      className={cn("mr-1.5 inline h-3 w-3", queue.isFetching && "animate-spin")}
                    />
                    Refresh
                  </button>
                </div>
              }
            >
              {queue.isLoading ? (
                <div className="space-y-2" data-testid="skeleton-queue">
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="h-16 animate-pulse rounded-md border border-border bg-muted/40" />
                  ))}
                </div>
              ) : queue.isError ? (
                <p className="text-sm text-destructive" data-testid="text-queue-error">
                  The queue could not be loaded. Re-enter the owner code and try again.
                </p>
              ) : (queue.data?.links.length ?? 0) === 0 ? (
                <div className="rounded-md border border-dashed border-border p-6 text-center" data-testid="text-queue-empty">
                  <Clock3 className="mx-auto h-5 w-5 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">Nothing in {ORDER_INTAKE_STATUS_LABELS[tab].toLowerCase()}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tab === "awaiting_client"
                      ? "Create a link above and send it to your buyer."
                      : "Links move here as buyers submit and you approve them."}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {queue.data?.links.map((link) => {
                    const Icon = STATUS_ICON[link.status];
                    return (
                      <li
                        key={link.id}
                        className="rounded-md border border-border bg-background/40 p-3"
                        data-testid={`row-intake-${link.id}`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-semibold" data-testid={`text-intake-label-${link.id}`}>
                                {link.internalLabel}
                              </p>
                              <StatusPill
                                tone={STATUS_TONE[link.status]}
                                icon={Icon}
                                label={ORDER_INTAKE_STATUS_LABELS[link.status]}
                                testId={`status-intake-${link.id}`}
                              />
                            </div>
                            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                              {link.confirmedItem || link.itemDescription}
                            </p>
                            {lineItemsForIntake(link).length > 1 ? (
                              <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-intake-line-count-${link.id}`}>
                                {lineItemsForIntake(link).length} HubSpot Print Orders on approve
                              </p>
                            ) : null}
                            <p className={`numeric mt-1.5 text-xs ${!link.submittedAt && expiryCue(link.expiresAt).urgent ? "text-primary" : "text-muted-foreground"}`}>
                              ${link.agreedAmount} · created {formatDate(link.createdAt)} ·{" "}
                              {link.submittedAt ? `submitted ${formatDate(link.submittedAt)}` : expiryCue(link.expiresAt).label}
                            </p>
                            {link.clientFullName && (
                              <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-intake-client-${link.id}`}>
                                {link.clientFullName}
                                {link.clientEmail ? ` · ${link.clientEmail}` : ""}
                              </p>
                            )}
                            {link.hubspotDealId && (
                              <p className="numeric mt-1 text-xs text-chart-4" data-testid={`text-intake-hubspot-${link.id}`}>
                                Deal {link.hubspotDealId} · Contact {link.hubspotContactId}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            {link.status === "awaiting_client" && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(marketplaceReminderText(link));
                                    toast({ title: "Reminder copied", description: "Paste it into Marketplace to nudge the buyer." });
                                  } catch {
                                    toast({ title: "Could not copy", description: "Select and copy the reminder manually if needed.", variant: "destructive" });
                                  }
                                }}
                                data-testid={`button-reminder-${link.id}`}
                              >
                                Copy reminder
                              </Button>
                            )}
                            {link.status === "pending_review" && (
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => setReviewId(link.id)}
                                data-testid={`button-review-${link.id}`}
                              >
                                Review
                              </Button>
                            )}
                            {link.status === "created" &&
                            (parseHubSpotDealsJson(link.hubspotDealsJson).length > 0
                              ? parseHubSpotDealsJson(link.hubspotDealsJson)
                              : link.hubspotDealId
                                ? [
                                    {
                                      dealId: link.hubspotDealId,
                                      dealName: link.hubspotDealName || link.hubspotDealId,
                                      amount: "",
                                      productName: "",
                                    },
                                  ]
                                : []
                            ).map((deal) => (
                              <Button
                                key={deal.dealId}
                                type="button"
                                size="sm"
                                onClick={() => setLocation(printsDealHref(deal.dealId))}
                                data-testid={`button-attach-plates-${link.id}-${deal.dealId}`}
                              >
                                Attach{parseHubSpotDealsJson(link.hubspotDealsJson).length > 1 ? ` · ${deal.productName || deal.dealName}` : " plates"}
                              </Button>
                            ))}
                            {link.status === "created" && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setReviewId(link.id)}
                                data-testid={`button-view-${link.id}`}
                              >
                                View
                              </Button>
                            )}
                            {(link.status === "awaiting_client" || link.status === "pending_review") && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => expireLink.mutate(link.id)}
                                disabled={expireLink.isPending}
                                data-testid={`button-expire-${link.id}`}
                              >
                                Expire
                              </Button>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </>
        )}
      </div>

      <ReviewDialog
        id={reviewId}
        headers={headers}
        onClose={() => setReviewId(null)}
        link={queue.data?.links.find((item) => item.id === reviewId) ?? null}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ review */

function ReviewDialog({
  id,
  link,
  headers,
  onClose,
}: {
  id: number | null;
  link: QueueLink | null;
  headers: Record<string, string>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [paymentVerified, setPaymentVerified] = useState(false);
  const [edits, setEdits] = useState<Record<string, string | boolean | number>>({});
  const [createdDeal, setCreatedDeal] = useState<{
    dealId: string;
    dealName: string;
    deals: Array<{ dealId: string; dealName: string; amount: string; productName: string }>;
  } | null>(null);

  useEffect(() => {
    setCreatedDeal(null);
    setPaymentVerified(false);
    setEdits({});
  }, [id]);

  const value = (key: keyof QueueLink): string => {
    const edited = edits[key as string];
    if (edited !== undefined) return String(edited);
    const stored = link ? link[key] : "";
    return stored === null || stored === undefined ? "" : String(stored);
  };

  const shippingRequired =
    edits.shippingRequired !== undefined ? Boolean(edits.shippingRequired) : Boolean(link?.shippingRequired);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { ...edits };
      if (edits.quantity !== undefined) body.quantity = Number(edits.quantity) || 1;
      await apiRequest("PATCH", `/api/order-links/${id}`, body, { headers });
    },
    onSuccess: () => {
      setEdits({});
      queryClient.invalidateQueries({ queryKey: ["/api/order-links"] });
      toast({ title: "Corrections saved", description: "The intake now shows your edited values." });
    },
    onError: (error: Error) =>
      toast({
        title: "Corrections were not saved",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      }),
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        `/api/order-links/${id}/create-order`,
        { paymentVerified: true },
        { headers },
      );
      return (await res.json()) as {
        ok: true;
        result: {
          dealName: string;
          dealId: string;
          contactId: string;
          deals: Array<{ dealId: string; dealName: string; amount: string; productName: string }>;
        };
      };
    },
    onSuccess: ({ result }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/order-links"] });
      setCreatedDeal({
        dealId: result.dealId,
        dealName: result.dealName,
        deals: result.deals?.length ? result.deals : [{ dealId: result.dealId, dealName: result.dealName, amount: "", productName: result.dealName }],
      });
      toast({
        title: "Created in HubSpot",
        description:
          (result.deals?.length ?? 1) > 1
            ? `${result.deals.length} Print Orders created on one Contact. Attach plates per item next.`
            : `${result.dealName} is in Deposit Received. Attach the first plate next.`,
      });
    },
    onError: (error: Error) =>
      toast({
        title: "HubSpot records were not created",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      }),
  });

  const runCreate = () => {
    const dirty = Object.keys(edits).length > 0;
    const lineCount = link ? lineItemsForIntake(link).length : 1;
    const proceed = window.confirm(
      lineCount > 1
        ? `Create one HubSpot Contact and ${lineCount} Print Orders (Deposit Received) for ${value("clientFullName") || "this buyer"} totaling $${value("agreedAmount")}?${
            dirty ? "\n\nUnsaved corrections will not be included — save them first if needed." : ""
          }`
        : `Create a HubSpot Contact and a Print Orders deal in Deposit Received for ${value("clientFullName") || "this buyer"} at $${value("agreedAmount")}?${
            dirty ? "\n\nUnsaved corrections will not be included — save them first if needed." : ""
          }`,
    );
    if (proceed) create.mutate();
  };

  const alreadyCreated = link?.status === "created";

  return (
    <Dialog open={id !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto" data-testid="dialog-review-intake">
        <DialogHeader>
          <DialogTitle data-testid="text-review-title">
            {alreadyCreated ? "Created order" : "Review submitted details"}
          </DialogTitle>
          <DialogDescription>
            {alreadyCreated
              ? "This intake already produced HubSpot records and is locked."
              : "Correct anything the buyer typed loosely, then confirm payment to enable the HubSpot write."}
          </DialogDescription>
        </DialogHeader>

        {!link ? (
          <p className="text-sm text-muted-foreground">This intake is no longer in the current view.</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 sm:grid-cols-3">
              <Readout label="Internal label" value={link.internalLabel} testId="text-review-label" />
              <Readout label="Submitted" value={formatDate(link.submittedAt)} testId="text-review-submitted" />
              <Readout
                label="Buyer payment checkbox"
                value={link.clientPaymentConfirmed ? "Confirmed by buyer" : "Not confirmed"}
                testId="text-review-buyer-payment"
              />
            </div>

            {lineItemsForIntake(link).length > 1 ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3" data-testid="panel-review-line-items">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Items → one Print Order each
                </p>
                <ul className="space-y-1.5">
                  {lineItemsForIntake(link).map((line, index) => (
                    <li
                      key={`${line.description}-${index}`}
                      className="flex items-baseline justify-between gap-3 text-sm"
                      data-testid={`text-review-line-${index}`}
                    >
                      <span className="min-w-0 truncate">
                        {line.description}
                        {line.quantity > 1 ? ` ×${line.quantity} @ $${line.amount}` : ""}
                      </span>
                      <span className="numeric shrink-0 text-muted-foreground">
                        ${intakeLineExtendedAmount(line).toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="numeric text-xs text-muted-foreground">
                  Total ${value("agreedAmount")} · {lineItemsForIntake(link).length} HubSpot deals on approve
                </p>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <ReviewField
                id="review-client-name"
                label="Buyer full name"
                value={value("clientFullName")}
                disabled={alreadyCreated}
                onChange={(v) => setEdits((c) => ({ ...c, clientFullName: v }))}
              />
              <ReviewField
                id="review-client-username"
                label="Marketplace username"
                value={value("clientUsername")}
                disabled={alreadyCreated}
                onChange={(v) => setEdits((c) => ({ ...c, clientUsername: v }))}
              />
              <ReviewField
                id="review-client-email"
                label="Email"
                value={value("clientEmail")}
                disabled={alreadyCreated}
                onChange={(v) => setEdits((c) => ({ ...c, clientEmail: v }))}
              />
              <ReviewField
                id="review-client-phone"
                label="Phone"
                value={value("clientPhone")}
                disabled={alreadyCreated}
                onChange={(v) => setEdits((c) => ({ ...c, clientPhone: v }))}
              />
              <div className="sm:col-span-2">
                <ReviewField
                  id="review-item"
                  label={lineItemsForIntake(link).length > 1 ? "Buyer confirmation notes" : "Item confirmed by buyer"}
                  value={value("confirmedItem") || value("itemDescription")}
                  disabled={alreadyCreated}
                  onChange={(v) => setEdits((c) => ({ ...c, confirmedItem: v }))}
                />
              </div>
              {lineItemsForIntake(link).length <= 1 ? (
                <ReviewField
                  id="review-quantity"
                  label="Quantity"
                  value={value("quantity")}
                  disabled={alreadyCreated}
                  onChange={(v) => setEdits((c) => ({ ...c, quantity: v }))}
                />
              ) : null}
              <ReviewField
                id="review-amount"
                label={lineItemsForIntake(link).length > 1 ? "Total agreed amount" : "Agreed amount paid"}
                value={value("agreedAmount")}
                disabled={alreadyCreated}
                onChange={(v) => setEdits((c) => ({ ...c, agreedAmount: v }))}
              />
              <div className="sm:col-span-2 flex items-center gap-2 text-sm">
                <span className="rule-label">Shipping</span>
                <span data-testid="text-review-shipping-required">
                  {shippingRequired ? "Required" : "Not required (pickup)"}
                </span>
              </div>
              {shippingRequired && (
                <>
                  <div className="sm:col-span-2">
                    <ReviewField
                      id="review-street"
                      label="Street"
                      value={value("shippingStreet")}
                      disabled={alreadyCreated}
                      onChange={(v) => setEdits((c) => ({ ...c, shippingStreet: v }))}
                    />
                  </div>
                  <ReviewField
                    id="review-city"
                    label="City"
                    value={value("shippingCity")}
                    disabled={alreadyCreated}
                    onChange={(v) => setEdits((c) => ({ ...c, shippingCity: v }))}
                  />
                  <ReviewField
                    id="review-state"
                    label="State / province"
                    value={value("shippingState")}
                    disabled={alreadyCreated}
                    onChange={(v) => setEdits((c) => ({ ...c, shippingState: v }))}
                  />
                  <ReviewField
                    id="review-postal"
                    label="Postal code"
                    value={value("shippingPostalCode")}
                    disabled={alreadyCreated}
                    onChange={(v) => setEdits((c) => ({ ...c, shippingPostalCode: v }))}
                  />
                  <ReviewField
                    id="review-country"
                    label="Country"
                    value={value("shippingCountry")}
                    disabled={alreadyCreated}
                    onChange={(v) => setEdits((c) => ({ ...c, shippingCountry: v }))}
                  />
                </>
              )}
              <div className="sm:col-span-2 space-y-1.5">
                <Label htmlFor="review-notes">Buyer notes</Label>
                <Textarea
                  id="review-notes"
                  className="min-h-20 resize-y text-sm"
                  value={value("clientNotes")}
                  disabled={alreadyCreated}
                  onChange={(event) => setEdits((c) => ({ ...c, clientNotes: event.target.value }))}
                  data-testid="input-review-notes"
                />
              </div>
            </div>

            {createdDeal || link.hubspotDealId ? (
              <div className="space-y-3" data-testid="panel-review-created-handoff">
                <p className="numeric rounded-md border border-chart-4/40 bg-chart-4/10 p-3 text-xs text-chart-4" data-testid="text-review-hubspot-ids">
                  HubSpot contact {link.hubspotContactId || "created"}
                  {(createdDeal?.deals?.length ?? parseHubSpotDealsJson(link.hubspotDealsJson).length) > 1
                    ? ` · ${createdDeal?.deals?.length ?? parseHubSpotDealsJson(link.hubspotDealsJson).length} Print Orders`
                    : ` · deal ${createdDeal?.dealId || link.hubspotDealId}`}
                </p>
                <div className="space-y-2">
                  {(createdDeal?.deals?.length
                    ? createdDeal.deals
                    : parseHubSpotDealsJson(link.hubspotDealsJson).length
                      ? parseHubSpotDealsJson(link.hubspotDealsJson)
                      : link.hubspotDealId
                        ? [
                            {
                              dealId: link.hubspotDealId,
                              dealName: link.hubspotDealName || link.hubspotDealId,
                              amount: "",
                              productName: link.itemDescription,
                            },
                          ]
                        : []
                  ).map((deal) => (
                    <div
                      key={deal.dealId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/25 px-3 py-2"
                      data-testid={`row-created-deal-${deal.dealId}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{deal.productName || deal.dealName}</p>
                        <p className="numeric mt-0.5 text-xs text-muted-foreground">
                          Deal {deal.dealId}
                          {deal.amount ? ` · $${deal.amount}` : ""}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          onClose();
                          setLocation(printsDealHref(deal.dealId));
                        }}
                        data-testid={`button-review-attach-${deal.dealId}`}
                      >
                        Attach plates
                      </Button>
                    </div>
                  ))}
                </div>
                <Button type="button" variant="outline" onClick={onClose} data-testid="button-review-done">
                  Done
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => save.mutate()}
                    disabled={save.isPending || Object.keys(edits).length === 0}
                    data-testid="button-save-review-edits"
                  >
                    {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Save corrections
                  </Button>
                </div>

                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-md border p-3",
                    paymentVerified ? "border-primary/35 bg-primary/5" : "border-border bg-muted/20",
                  )}
                  data-testid="control-review-payment-verified"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-primary"
                    checked={paymentVerified}
                    onChange={(event) => setPaymentVerified(event.target.checked)}
                    data-testid="checkbox-payment-verified"
                  />
                  <span>
                    <span className="block text-sm font-medium">
                      I verified this payment cleared and the price is correct
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Required before anything can be written to HubSpot.
                    </span>
                  </span>
                </label>

                <Button
                  type="button"
                  className="w-full"
                  onClick={runCreate}
                  disabled={!paymentVerified || create.isPending}
                  data-testid="button-create-hubspot-order"
                >
                  {create.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <PlusCircle className="mr-2 h-4 w-4" />
                  )}
                  Create Contact and Print Order in HubSpot
                </Button>
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Creates one Contact (reused if the email already exists) and one associated deal in
                  the Print Orders pipeline at Deposit Received. This runs once per intake.
                </p>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------- primitives */

function Readout({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <p className="rule-label">{label}</p>
      <p className="mt-0.5 text-sm" data-testid={testId}>
        {value || "—"}
      </p>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  required,
  inputMode,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  inputMode?: "decimal" | "email" | "tel" | "text";
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-primary"> *</span>}
      </Label>
      <Input
        id={id}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`input-${id}`}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ReviewField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`input-${id}`}
      />
    </div>
  );
}
