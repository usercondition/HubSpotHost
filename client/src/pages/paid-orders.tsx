import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  ExternalLink,
  FileUp,
  Loader2,
  Plus,
  PlusCircle,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { parseApiError } from "@/lib/api-error";
import { formatMoney } from "@/lib/format";
import { printsDealHref, queueDealHref, hubspotDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type {
  PaidOrderAnalysis,
  PaidOrderCreateResult,
  PaidOrderDraft,
  ReturningBuyerProfile,
} from "@shared/schema";

type LineDraft = { id: string; productName: string; amount: string; kind: "print" | "shipping" | "fee" };

type ContactDraft = Omit<PaidOrderDraft, "paymentConfirmed" | "productName" | "amount">;

const EMPTY_CONTACT: ContactDraft = {
  fullName: "",
  marketplaceUsername: "",
  email: "",
  phone: "",
  address: "",
  address2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "United States",
  conversationSummary: "",
};

function newLine(seed?: Partial<LineDraft>): LineDraft {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productName: seed?.productName ?? "",
    amount: seed?.amount ?? "",
    kind: seed?.kind ?? "print",
  };
}

function parseAmount(value: string): number {
  return Number(String(value).replace(/[$,\s]/g, ""));
}

/**
 * Manual order entry — type paid buyer + item details straight into HubSpot.
 * Optional conversation paste only assists fill; create does not require it.
 */
export default function PaidOrders() {
  const { toast } = useToast();
  const { isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: 'Manual entry unlocked',
    successDescription: 'Enter the paid order details, confirm payment, then create in HubSpot.',
  });

  const [contact, setContact] = useState<ContactDraft>(EMPTY_CONTACT);
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [showAssist, setShowAssist] = useState(false);
  const [conversation, setConversation] = useState("");
  const [assistHints, setAssistHints] = useState<PaidOrderAnalysis | null>(null);
  const [created, setCreated] = useState<PaidOrderCreateResult | null>(null);
  const [buyerHint, setBuyerHint] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const bridgeHandled = useRef<string | null>(null);
  const search = useSearch();

  const applyAnalysis = (analysis: PaidOrderAnalysis) => {
    setAssistHints(analysis);
    setContact((current) => ({
      fullName: current.fullName || analysis.fullName,
      marketplaceUsername: current.marketplaceUsername || analysis.marketplaceUsername,
      email: current.email || analysis.email,
      phone: current.phone || analysis.phone,
      address: current.address || analysis.address,
      city: current.city || analysis.city,
      state: current.state || analysis.state,
      postalCode: current.postalCode || analysis.postalCode,
      country: current.country || analysis.country || "United States",
      conversationSummary: current.conversationSummary || analysis.conversationSummary,
    }));
    setLines((current) => {
      const first = current[0];
      const blank = current.length === 1 && !first?.productName.trim() && !first?.amount.trim();
      if (blank && (analysis.productName || analysis.amount)) {
        return [newLine({ productName: analysis.productName, amount: analysis.amount })];
      }
      return current;
    });
    if (analysis.paymentLanguageDetected) setPaymentConfirmed(true);
  };

  const lineTotal = useMemo(() => {
    return lines.reduce((sum, line) => {
      const amount = parseAmount(line.amount);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
  }, [lines]);

  const lookupBuyer = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        "/api/buyers/lookup",
        { email: contact.email.trim() },
        { headers },
      );
      return (await response.json()) as { ok: true; buyer: ReturningBuyerProfile };
    },
    onSuccess: ({ buyer }) => {
      if (!buyer.found) {
        setBuyerHint("No matching HubSpot contact or prior intake for that email.");
        toast({ title: "No returning buyer found" });
        return;
      }
      setContact((current) => ({
        ...current,
        fullName: current.fullName || buyer.fullName,
        marketplaceUsername: current.marketplaceUsername || buyer.username,
        phone: current.phone || buyer.phone,
        address: current.address || buyer.address,
        address2: current.address2 || buyer.address2,
        city: current.city || buyer.city,
        state: current.state || buyer.state,
        postalCode: current.postalCode || buyer.postalCode,
        country: current.country || buyer.country || current.country,
      }));
      setBuyerHint(
        `Prefill from ${buyer.source}${buyer.priorOrders ? ` · ${buyer.priorOrders} prior intake(s)` : ""}${
          buyer.hubspotContactId ? ` · contact ${buyer.hubspotContactId}` : ""
        }`,
      );
      toast({ title: "Returning buyer loaded", description: "Blank fields were filled from HubSpot / prior intake." });
    },
    onError: (error: Error) => {
      toast({
        title: "Buyer lookup failed",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const analyze = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        "/api/paid-orders/analyze",
        { conversation },
        { headers },
      );
      return (await response.json()) as { ok: true; analysis: PaidOrderAnalysis };
    },
    onSuccess: ({ analysis }) => {
      applyAnalysis(analysis);
      setCreated(null);
      toast({
        title: "Suggestions applied to the form",
        description: analysis.missing.length
          ? `Still verify: ${analysis.missing.slice(0, 3).join("; ")}.`
          : "Review every field, then confirm payment before creating.",
      });
    },
    onError: (error: Error) => {
      const message = error.message;
      toast({
        title: "Could not read that conversation",
        description: message.startsWith("400:")
          ? "Paste a few more lines — buyer, item, price, and payment if you have them."
          : message.startsWith("401:")
            ? "Owner session expired. Unlock again."
            : message.slice(0, 180),
        variant: "destructive",
      });
    },
  });

  // Clients handoff: /paid-orders?q=Name — seed the contact name field once.
  useEffect(() => {
    const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
    const q = params.get("q")?.trim();
    if (q) {
      setContact((current) => (current.fullName.trim() ? current : { ...current, fullName: q }));
    }
  }, [search]);

  // Chrome extension deep-link: /paid-orders?bridge=<id>
  useEffect(() => {
    const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
    const bridgeId = params.get("bridge")?.trim() || "";
    if (!bridgeId || bridgeHandled.current === bridgeId) return;
    bridgeHandled.current = bridgeId;
    setBridgeStatus("loading");
    setShowAssist(true);

    void (async () => {
      try {
        const response = await fetch(`/api/paid-orders/messenger-bridge/${encodeURIComponent(bridgeId)}`);
        const body = (await response.json()) as {
          ok?: boolean;
          conversation?: string;
          title?: string;
          error?: string;
        };
        if (!response.ok || !body.ok || !body.conversation) {
          throw new Error(body.error || "Messenger scan bridge expired");
        }
        setConversation(body.conversation);
        setBridgeStatus("ready");
        toast({
          title: "Messenger thread loaded",
          description: body.title
            ? `Imported “${body.title}”. Unlock if needed, then apply suggestions.`
            : "Imported from the Chrome extension. Unlock if needed, then apply suggestions.",
        });
        // Strip bridge id so refresh doesn't 404 on consumed token.
        const next = new URL(window.location.href);
        next.searchParams.delete("bridge");
        window.history.replaceState({}, "", `${next.pathname}${next.search}${next.hash}`);
      } catch (error) {
        setBridgeStatus("error");
        toast({
          title: "Could not load Messenger scan",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      }
    })();
  }, [search, toast]);

  // After unlock, auto-apply if a bridge thread is sitting in the assist box.
  useEffect(() => {
    if (!isUnlocked || bridgeStatus !== "ready") return;
    if (conversation.trim().length < 20 || assistHints) return;
    analyze.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when unlock + bridge ready
  }, [isUnlocked, bridgeStatus]);

  const create = useMutation({
    mutationFn: async () => {
      const cleanedLines = lines
        .map((line) => ({
          productName: line.productName.trim(),
          amount: line.amount.trim(),
          kind: line.kind,
        }))
        .filter((line) => line.productName.length > 0 || line.amount.length > 0);

      const primary = cleanedLines[0] ?? { productName: "", amount: "" };
      const draft: PaidOrderDraft = {
        paymentConfirmed,
        fullName: contact.fullName.trim(),
        marketplaceUsername: contact.marketplaceUsername.trim(),
        email: contact.email.trim(),
        phone: contact.phone.trim(),
        address: contact.address.trim(),
        address2: contact.address2?.trim() || "",
        city: contact.city.trim(),
        state: contact.state.trim(),
        postalCode: contact.postalCode.trim(),
        country: contact.country.trim(),
        productName: primary.productName,
        amount: primary.amount,
        conversationSummary:
          contact.conversationSummary.trim() ||
          `Manual paid-order entry.${cleanedLines.length > 1 ? ` ${cleanedLines.length} items.` : ""}`,
      };

      const response = await apiRequest(
        "POST",
        "/api/paid-orders",
        {
          ...draft,
          lineItems: cleanedLines,
        },
        { headers },
      );
      return (await response.json()) as { ok: true; result: PaidOrderCreateResult };
    },
    onSuccess: ({ result }) => {
      setCreated(result);
      toast({
        title: "Paid order created in HubSpot",
        description:
          result.deals.length > 1
            ? `${result.deals.length} Print Orders on one Contact — Deposit Received.`
            : `${result.dealName} is now in Deposit Received.`,
      });
    },
    onError: (error: Error) => {
      const message = error.message;
      const apiMessage = message.match(/"error":"([^"]+)"/)?.[1];
      toast({
        title: "HubSpot record was not created",
        description: apiMessage || (message.startsWith("401:") ? "Unlock with your owner code and try again." : message.slice(0, 180)),
        variant: "destructive",
      });
    },
  });

  const updateContact = <K extends keyof ContactDraft>(field: K, value: ContactDraft[K]) => {
    setContact((current) => ({ ...current, [field]: value }));
    setCreated(null);
  };

  const updateLine = (id: string, patch: Partial<Omit<LineDraft, "id">>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
    setCreated(null);
  };

  const resetForm = () => {
    setContact(EMPTY_CONTACT);
    setLines([newLine()]);
    setPaymentConfirmed(false);
    setConversation("");
    setAssistHints(null);
    setCreated(null);
    setShowAssist(false);
  };

  const startCreate = () => {
    if (!paymentConfirmed) {
      toast({
        title: "Confirm payment first",
        description: "Manual entry only creates HubSpot records after you verify payment.",
        variant: "destructive",
      });
      return;
    }
    if (!contact.fullName.trim() && !contact.marketplaceUsername.trim()) {
      toast({
        title: "Buyer name required",
        description: "Enter a client name or Marketplace username.",
        variant: "destructive",
      });
      return;
    }
    const cleaned = lines.filter((line) => line.productName.trim() || line.amount.trim());
    if (
      cleaned.length === 0 ||
      cleaned.some((line) => !line.productName.trim() || !(parseAmount(line.amount) >= 0) || line.amount.trim() === "")
    ) {
      toast({
        title: "Order items incomplete",
        description: "Each item needs a description and an amount of zero or more (use $0 for gifts / tracking).",
        variant: "destructive",
      });
      return;
    }

    const label =
      cleaned.length > 1
        ? `${cleaned.length} items totaling ${formatMoney(lineTotal)}`
        : `${cleaned[0]!.productName} at ${formatMoney(parseAmount(cleaned[0]!.amount))}`;
    const proceed = window.confirm(`Create the paid HubSpot order for ${label}?`);
    if (proceed) create.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Manual order entry"
        subtitle="Type a paid buyer’s details and create the HubSpot Contact + Print Order — no order form required."
        actions={
          <StatusPill tone="good" icon={ShieldCheck} label="Paid orders only" testId="status-paid-only" />
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock Manual Entry"
            description="Same owner code as Intake and Daily Work. Creates HubSpot Contact and Deposit Received deals only after you confirm payment."
            buttonLabel="Unlock Manual Entry"
            testIdPrefix="manual"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : (
          <>
            <section className="rounded-md border border-card-border bg-card px-4 py-3" data-testid="panel-manual-intro">
              <p className="text-sm text-muted-foreground">
                Fill the form below for a paid Marketplace (or other) order. Prefer{" "}
                <Link href="/orders" className="hs-link font-medium">
                  Intake
                </Link>{" "}
                when the buyer still needs a details link. Conversation paste is optional assist only.
              </p>
              <div
                className="mt-3 rounded-md border border-border bg-muted/25 px-3 py-2.5 text-xs text-muted-foreground"
                data-testid="panel-messenger-extension-install"
              >
                <p className="font-medium text-foreground">Marketplace secretary (Chrome helper)</p>
                <ol className="mt-1.5 list-decimal space-y-1 pl-4">
                  <li>
                    <a
                      className="hs-link font-medium"
                      href="/downloads/messenger-send-to-print-ops-v1.zip"
                      download
                    >
                      Download the Chrome helper zip
                    </a>
                  </li>
                  <li>Unzip → open the folder that contains <code className="text-[0.7rem]">manifest.json</code></li>
                  <li>
                    Chrome → <code className="text-[0.7rem]">chrome://extensions</code> → enable{" "}
                    <strong className="font-medium text-foreground">Developer mode</strong> →{" "}
                    <strong className="font-medium text-foreground">Load unpacked</strong> → select that folder
                  </li>
                  <li>
                    Extension Options: keep the Print Ops URL, paste your owner access code, Save
                  </li>
                  <li>
                    In Comet, open Messenger with its chat list visible → extension → <strong className="font-medium text-foreground">Inbox brief</strong>{" "}
                    (secretary summary on the <Link href="/marketplace-brief" className="hs-link">Brief</Link> page).
                    Optional: send one thread into Manual.
                  </li>
                </ol>
                <p className="mt-1.5">
                  If Meta’s UI breaks the scrape, tell me what you saw — we improve or remove.
                </p>
              </div>
            </section>

            <Panel
              title="Buyer & shipping"
              description="Reuses an existing HubSpot Contact when the email already matches."
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAssist((value) => !value)}
                  data-testid="button-toggle-conversation-assist"
                >
                  <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" />
                  {showAssist ? "Hide paste assist" : "Fill from conversation"}
                </Button>
              }
            >
              {showAssist ? (
                <div className="mb-5 space-y-3 rounded-md border border-border bg-muted/30 p-3" data-testid="panel-conversation-assist">
                  <p className="text-xs text-muted-foreground">
                    Paste a Marketplace thread, or use the Chrome extension “Send to Print Ops”
                    (loads the full selected chat via <code className="text-[0.7rem]">?bridge=</code>
                    ). Nothing is saved until you create the order.
                    {bridgeStatus === "loading"
                      ? " Loading Messenger scan…"
                      : bridgeStatus === "ready"
                        ? " Messenger scan loaded — apply suggestions after unlock."
                        : bridgeStatus === "error"
                          ? " Messenger scan failed — run Send to Print Ops again."
                          : ""}
                  </p>
                  <Textarea
                    id="marketplace-conversation"
                    className="min-h-36 resize-y font-mono text-xs leading-relaxed"
                    value={conversation}
                    onChange={(event) => setConversation(event.target.value)}
                    placeholder={"Buyer: Jane Smith\nPaid $350 for Acastus Knight…\nShip to 123 Resin Way, San Diego CA 92101"}
                    data-testid="input-marketplace-conversation"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (conversation.trim().length < 20) {
                        toast({
                          title: "Paste a bit more of the thread",
                          description: "Include buyer, item, price, and payment language if you have it.",
                          variant: "destructive",
                        });
                        return;
                      }
                      analyze.mutate();
                    }}
                    disabled={analyze.isPending}
                    data-testid="button-analyze-conversation"
                  >
                    {analyze.isPending ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-3.5 w-3.5" />
                    )}
                    Apply suggestions to form
                  </Button>
                  {assistHints ? (
                    <div
                      className={cn(
                        "rounded-md border p-3 text-xs",
                        assistHints.paymentLanguageDetected
                          ? "border-primary/25 bg-primary/5"
                          : "border-amber-500/35 bg-amber-500/5",
                      )}
                      data-testid="panel-payment-detection"
                    >
                      <div className="flex gap-2">
                        {assistHints.paymentLanguageDetected ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        ) : (
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        )}
                        <div>
                          <p className="font-medium text-foreground">
                            {assistHints.paymentLanguageDetected
                              ? "Payment language detected — confirm below before creating"
                              : "Payment confirmation was not clear in the paste"}
                          </p>
                          {assistHints.missing.length > 0 ? (
                            <ul className="mt-1.5 space-y-0.5 text-muted-foreground" data-testid="list-missing-details">
                              {assistHints.missing.map((item) => (
                                <li key={item}>• {item}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Client name"
                  id="full-name"
                  value={contact.fullName}
                  onChange={(value) => updateContact("fullName", value)}
                  required
                />
                <Field
                  label="Marketplace username"
                  id="marketplace-username"
                  value={contact.marketplaceUsername}
                  onChange={(value) => updateContact("marketplaceUsername", value)}
                />
                <Field
                  label="Email"
                  id="email"
                  value={contact.email}
                  onChange={(value) => {
                    updateContact("email", value);
                    setBuyerHint(null);
                  }}
                  type="email"
                />
                <div className="flex items-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={!contact.email.includes("@") || lookupBuyer.isPending}
                    onClick={() => lookupBuyer.mutate()}
                    data-testid="button-lookup-returning-buyer"
                  >
                    {lookupBuyer.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    Prefill returning buyer
                  </Button>
                </div>
                {buyerHint ? (
                  <p className="sm:col-span-2 text-xs text-muted-foreground" data-testid="text-buyer-lookup-hint">
                    {buyerHint}
                  </p>
                ) : null}
                <Field
                  label="Phone"
                  id="phone"
                  value={contact.phone}
                  onChange={(value) => updateContact("phone", value)}
                  type="tel"
                />
                <div className="sm:col-span-2">
                  <Field
                    label="Shipping address"
                    id="address"
                    value={contact.address}
                    onChange={(value) => updateContact("address", value)}
                  />
                </div>
                <Field
                  label="Apt / suite / unit"
                  id="address2"
                  value={contact.address2 || ""}
                  onChange={(value) => updateContact("address2", value)}
                />
                <Field label="City" id="city" value={contact.city} onChange={(value) => updateContact("city", value)} />
                <Field label="State / region" id="state" value={contact.state} onChange={(value) => updateContact("state", value)} />
                <Field
                  label="Postal code"
                  id="postal-code"
                  value={contact.postalCode}
                  onChange={(value) => updateContact("postalCode", value)}
                />
                <Field
                  label="Country"
                  id="country"
                  value={contact.country}
                  onChange={(value) => updateContact("country", value)}
                />
                <div className="sm:col-span-2 space-y-1.5">
                  <Label htmlFor="draft-summary">Notes for HubSpot deal description</Label>
                  <Textarea
                    id="draft-summary"
                    className="min-h-20 resize-y text-sm"
                    value={contact.conversationSummary}
                    onChange={(event) => updateContact("conversationSummary", event.target.value)}
                    placeholder="Optional — payment method, ship-by date, special requests…"
                    data-testid="input-draft-summary"
                  />
                </div>
              </div>
            </Panel>

            <Panel
              title="Order items"
              description="One HubSpot Print Order deal per item. Mark shipping/fee lines so they never ask for plates."
              actions={
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLines((current) => [
                        ...current,
                        newLine({ productName: "Shipping", amount: "", kind: "shipping" }),
                      ]);
                      setCreated(null);
                    }}
                    data-testid="button-add-manual-shipping"
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add shipping
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLines((current) => [
                        ...current,
                        newLine({ productName: "Paypal fee", amount: "", kind: "fee" }),
                      ]);
                      setCreated(null);
                    }}
                    data-testid="button-add-manual-fee"
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add fee
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLines((current) => [...current, newLine()]);
                      setCreated(null);
                    }}
                    data-testid="button-add-manual-line"
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add item
                  </Button>
                </div>
              }
            >
              <div className="space-y-3">
                {lines.map((line, index) => (
                  <div
                    key={line.id}
                    className="grid gap-3 rounded-md border border-border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_8rem_9rem_auto]"
                    data-testid={`row-manual-line-${index}`}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor={`line-product-${line.id}`}>
                        Item {index + 1}
                        <span className="text-primary"> *</span>
                      </Label>
                      <Input
                        id={`line-product-${line.id}`}
                        value={line.productName}
                        onChange={(event) => updateLine(line.id, { productName: event.target.value })}
                        placeholder={
                          line.kind === "shipping"
                            ? "Shipping"
                            : line.kind === "fee"
                              ? "Paypal fee"
                              : "Model or order description"
                        }
                        data-testid={`input-line-product-${index}`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`line-amount-${line.id}`}>
                        Amount
                        <span className="text-primary"> *</span>
                      </Label>
                      <Input
                        id={`line-amount-${line.id}`}
                        inputMode="decimal"
                        value={line.amount}
                        onChange={(event) => updateLine(line.id, { amount: event.target.value })}
                        placeholder="0.00"
                        data-testid={`input-line-amount-${index}`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`line-kind-${line.id}`}>Type</Label>
                      <select
                        id={`line-kind-${line.id}`}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                        value={line.kind}
                        onChange={(event) => {
                          const value = event.target.value;
                          updateLine(line.id, {
                            kind: value === "shipping" || value === "fee" ? value : "print",
                          });
                        }}
                        data-testid={`select-line-kind-${index}`}
                      >
                        <option value="print">Print item</option>
                        <option value="shipping">Shipping (no plates)</option>
                        <option value="fee">Fee / surcharge (no plates)</option>
                      </select>
                    </div>
                    <div className="flex items-end">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={lines.length <= 1}
                        onClick={() => {
                          setLines((current) => current.filter((item) => item.id !== line.id));
                          setCreated(null);
                        }}
                        aria-label={`Remove item ${index + 1}`}
                        data-testid={`button-remove-manual-line-${index}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                <div className="flex justify-between gap-3 border-t border-border pt-3 text-sm">
                  <span className="text-muted-foreground">
                    {lines.length} item{lines.length === 1 ? "" : "s"} · {lines.length} HubSpot deal
                    {lines.length === 1 ? "" : "s"}
                    {lines.some((line) => line.kind === "shipping" || line.kind === "fee")
                      ? " · shipping/fee lines skip plate prompts"
                      : ""}
                  </span>
                  <span className="numeric font-semibold" data-testid="text-manual-line-total">
                    {formatMoney(lineTotal)}
                  </span>
                </div>
              </div>
            </Panel>

            <Panel title="Confirm & create" description="Creates Contact + Deposit Received Print Order(s). Nothing writes until you confirm.">
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3",
                  paymentConfirmed ? "border-primary/35 bg-primary/5" : "border-border bg-muted/20",
                )}
                data-testid="control-payment-confirmation"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={paymentConfirmed}
                  onChange={(event) => {
                    setPaymentConfirmed(event.target.checked);
                    setCreated(null);
                  }}
                  data-testid="checkbox-payment-confirmed"
                />
                <span>
                  <span className="block text-sm font-medium">Payment has been confirmed</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Check this after payment cleared — or for a $0 gift / tracking order you are ready to create.
                  </span>
                </span>
              </label>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="min-w-[14rem]"
                  onClick={startCreate}
                  disabled={create.isPending || !paymentConfirmed || Boolean(created)}
                  data-testid="button-create-paid-order"
                >
                  {create.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <PlusCircle className="mr-2 h-4 w-4" />
                  )}
                  Create in HubSpot
                </Button>
                {created ? (
                  <Button type="button" variant="outline" onClick={resetForm} data-testid="button-manual-new-order">
                    Enter another order
                  </Button>
                ) : null}
              </div>

              {created ? (
                <div
                  className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-4"
                  data-testid="panel-paid-order-created"
                >
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">Paid order created in HubSpot</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {created.deals.length > 1
                          ? `${created.deals.length} Print Orders in Deposit Received on one Contact.`
                          : `${created.dealName} is in Deposit Received.`}{" "}
                        Contact was {created.contactStatus === "existing" ? "matched by email" : "created new"}.
                      </p>
                      <p className="mt-2 numeric text-xs text-muted-foreground">Contact ID {created.contactId}</p>
                      <ul className="mt-3 space-y-2">
                        {created.deals.map((deal) => (
                          <li
                            key={deal.dealId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                            data-testid={`row-created-deal-${deal.dealId}`}
                          >
                            <div className="min-w-0">
                              <p className="truncate font-medium">{deal.dealName}</p>
                              <p className="numeric text-xs text-muted-foreground">
                                Deal {deal.dealId} · {formatMoney(parseAmount(deal.amount))}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button asChild size="sm" data-testid={`button-open-queue-${deal.dealId}`}>
                                <Link href={queueDealHref(deal.dealId)}>Ops / Queue</Link>
                              </Button>
                              <Button asChild size="sm" variant="outline" data-testid={`button-attach-plates-${deal.dealId}`}>
                                <Link href={printsDealHref(deal.dealId)}>
                                  <FileUp className="mr-1.5 h-3.5 w-3.5" />
                                  Attach plates
                                </Link>
                              </Button>
                              <Button asChild size="sm" variant="ghost">
                                <a
                                  href={hubspotDealHref(deal.dealId)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  data-testid={`link-hubspot-deal-${deal.dealId}`}
                                >
                                  HubSpot
                                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                                </a>
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ) : null}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  id,
  value,
  onChange,
  required,
  type = "text",
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-primary"> *</span> : null}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`input-${id}`}
      />
    </div>
  );
}
