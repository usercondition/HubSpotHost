import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  FileText,
  KeyRound,
  Loader2,
  LockKeyhole,
  PlusCircle,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, ThemeToggle } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import type { PaidOrderAnalysis, PaidOrderCreateResult, PaidOrderDraft } from "@shared/schema";

const EMPTY_DRAFT: PaidOrderDraft = {
  paymentConfirmed: false,
  fullName: "",
  marketplaceUsername: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  state: "",
  postalCode: "",
  country: "",
  productName: "",
  amount: "",
  conversationSummary: "",
};

function asDraft(analysis: PaidOrderAnalysis): PaidOrderDraft {
  return {
    paymentConfirmed: false,
    fullName: analysis.fullName,
    marketplaceUsername: analysis.marketplaceUsername,
    email: analysis.email,
    phone: analysis.phone,
    address: analysis.address,
    city: analysis.city,
    state: analysis.state,
    postalCode: analysis.postalCode,
    country: analysis.country,
    productName: analysis.productName,
    amount: analysis.amount,
    conversationSummary: analysis.conversationSummary,
  };
}

type FieldKey = Exclude<keyof PaidOrderDraft, "paymentConfirmed">;

export default function PaidOrders() {
  const { toast } = useToast();
  const [conversation, setConversation] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"unchecked" | "checking" | "ready" | "stale">(
    "unchecked",
  );
  const [analysis, setAnalysis] = useState<PaidOrderAnalysis | null>(null);
  const [draft, setDraft] = useState<PaidOrderDraft>(EMPTY_DRAFT);
  const [created, setCreated] = useState<PaidOrderCreateResult | null>(null);

  const headers = () => ({ "x-paid-order-access-code": accessCode });

  const checkLiveConnection = async () => {
    setConnectionStatus("checking");
    try {
      const res = await apiRequest("GET", "/api/health");
      const health = (await res.json()) as {
        paidOrderIntake?: { accessCodeConfigured?: boolean; buildId?: string };
      };
      const ready = health.paidOrderIntake?.accessCodeConfigured === true;
      setConnectionStatus(ready ? "ready" : "stale");
      toast({
        title: ready ? "Connected to the current live intake service" : "This page is not on the current live intake service",
        description: ready
          ? "You can use the printed access code on this page."
          : "Open the public Print Orders site directly, then return to Paid order intake.",
        variant: ready ? "default" : "destructive",
      });
    } catch {
      setConnectionStatus("stale");
      toast({
        title: "This page cannot reach the live intake service",
        description: "Open the public Print Orders site directly, then return to Paid order intake.",
        variant: "destructive",
      });
    }
  };

  const analyze = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/paid-orders/analyze",
        { conversation, intakeAccessCode: accessCode },
        { headers: headers() },
      );
      return (await res.json()) as { ok: true; analysis: PaidOrderAnalysis };
    },
    onSuccess: ({ analysis: extracted }) => {
      setAnalysis(extracted);
      setDraft(asDraft(extracted));
      setCreated(null);
      toast({
        title: "Conversation reviewed",
        description: "Check the suggestions, complete missing details, then confirm payment.",
      });
    },
    onError: (error: Error) => {
      const message = error.message;
      const apiMessage = message.match(/"error":"([^"]+)"/)?.[1];
      const description = message.startsWith("401:")
        ? apiMessage === "No intake access code reached the live service"
          ? "Your browser did not deliver the code to the service. The updated page now also sends it securely in the request body. Refresh and try once more."
          : apiMessage === "The intake access code does not match the active code"
            ? "The live server has a different intake code than the one entered. We need to replace the saved code with a fresh one."
            : "The intake code is missing, expired, or does not match the current code."
        : message.startsWith("503:")
          ? "The live service does not have an intake code configured yet. Refresh the page and try again in a moment."
          : message.startsWith("400:")
            ? "Paste the complete paid Marketplace conversation, including a few lines of buyer and payment details."
            : message.slice(0, 180);
      toast({
        title: "Could not analyze the conversation",
        description,
        variant: "destructive",
      });
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/paid-orders",
        { ...draft, intakeAccessCode: accessCode },
        { headers: headers() },
      );
      return (await res.json()) as { ok: true; result: PaidOrderCreateResult };
    },
    onSuccess: ({ result }) => {
      setCreated(result);
      toast({
        title: "Paid order created in HubSpot",
        description: `${result.dealName} is now in Deposit Received.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "HubSpot record was not created",
        description: error.message.slice(0, 180),
        variant: "destructive",
      });
    },
  });

  const update = (field: FieldKey, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setCreated(null);
  };

  const startAnalysis = () => {
    if (conversation.trim().length < 20) {
      toast({
        title: "Paste the paid conversation first",
        description: "Include the customer’s request, price, payment confirmation, and shipping details if available.",
        variant: "destructive",
      });
      return;
    }
    if (!accessCode.trim()) {
      toast({
        title: "Enter the intake access code",
        description: "The code protects HubSpot from unauthorized order creation.",
        variant: "destructive",
      });
      return;
    }
    analyze.mutate();
  };

  const createRecord = () => {
    if (!draft.paymentConfirmed) {
      toast({
        title: "Confirm payment first",
        description: "This intake never creates records for unpaid conversations.",
        variant: "destructive",
      });
      return;
    }
    const proceed = window.confirm(
      `Create the paid HubSpot order for ${draft.productName || "this order"} at $${draft.amount || "0"}?`,
    );
    if (proceed) create.mutate();
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Manual order entry"
        subtitle="Use this when you already have a paid buyer's details and do not need to send an order form."
        actions={
          <>
            <StatusPill
              tone="good"
              icon={ShieldCheck}
              label="Paid orders only"
              testId="status-paid-only"
            />
            <ThemeToggle />
          </>
        }
      />

      <div className="page-stack">
        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(20rem,0.95fr)]">
          <Panel
            title="1. Paste the paid Marketplace conversation"
            description="Analysis is private to this session. The raw conversation is not saved as a HubSpot record."
          >
            <div className="space-y-4">
              <div className="rounded-md border border-primary/25 bg-primary/5 p-3">
                <div className="flex items-start gap-2.5">
                  <ClipboardPaste className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-sm text-muted-foreground">
                    Paste enough of the thread to show who ordered, what they want, the agreed
                    price, payment confirmation, and shipping information. You will review all
                    extracted fields before a record can be created.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="marketplace-conversation">Facebook Marketplace conversation</Label>
                <Textarea
                  id="marketplace-conversation"
                  className="min-h-64 resize-y font-mono text-xs leading-relaxed"
                  value={conversation}
                  onChange={(event) => setConversation(event.target.value)}
                  placeholder={"Buyer: John Smith\nI'm paid for the Acastus Knight Porphyrion at $350. Please ship to...\nPayment sent. My address is..."}
                  data-testid="input-marketplace-conversation"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="intake-access-code">Intake access code</Label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="intake-access-code"
                    type="password"
                    autoComplete="off"
                    className="pl-9"
                    value={accessCode}
                    onChange={(event) => setAccessCode(event.target.value)}
                    placeholder="Enter your private intake code"
                    data-testid="input-intake-access-code"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  This code is not retained by the page. It protects the HubSpot record-creation action.
                </p>
              </div>

              <Button
                type="button"
                variant="outline"
                onClick={checkLiveConnection}
                disabled={connectionStatus === "checking"}
                className="w-full"
                data-testid="button-check-live-intake-connection"
              >
                {connectionStatus === "checking" ? "Checking live connection..." : "Check live intake connection"}
              </Button>

              {connectionStatus === "ready" ? (
                <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400" data-testid="text-live-intake-ready">
                  Connected to current live intake service.
                </p>
              ) : null}

              <Button
                type="button"
                onClick={startAnalysis}
                disabled={analyze.isPending}
                className="w-full"
                data-testid="button-analyze-conversation"
              >
                {analyze.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Analyze conversation and prepare order
              </Button>
            </div>
          </Panel>

          <Panel
            title="What happens and what does not"
            description="A paid order enters operations only after your final confirmation."
          >
            <ol className="space-y-4">
              {[
                {
                  title: "Analyze, do not save",
                  text: "The intake makes editable suggestions for customer details, price, model, shipping, and a summary.",
                  icon: Sparkles,
                },
                {
                  title: "Confirm payment",
                  text: "You must explicitly check payment confirmation before the create button becomes usable.",
                  icon: CheckCircle2,
                },
                {
                  title: "Create Contact and Deal",
                  text: "HubSpot receives one associated client record and one Deal in the Print Orders Deposit Received stage.",
                  icon: UserRound,
                },
                {
                  title: "Run the job normally",
                  text: "You move the order through File Check, Printing, QC, shipping, and the margin fields update as costs are added.",
                  icon: FileText,
                },
              ].map((item, index) => (
                <li key={item.title} className="flex gap-3" data-testid={`step-intake-${index + 1}`}>
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-primary">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{item.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-5 rounded-md border border-border bg-muted/35 p-3">
              <div className="flex gap-2">
                <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  This page is for paid orders only. It does not create leads, save unpaid inquiries,
                  or send customer messages.
                </p>
              </div>
            </div>
          </Panel>
        </section>

        {analysis && (
          <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <Panel
              title="2. Review the extraction"
              description="The analysis is a starting point. Complete or correct every important detail."
            >
              <div className="space-y-4">
                <div
                  className={`rounded-md border p-3 ${
                    analysis.paymentLanguageDetected
                      ? "border-primary/25 bg-primary/5"
                      : "border-amber-500/35 bg-amber-500/5"
                  }`}
                  data-testid="panel-payment-detection"
                >
                  <div className="flex gap-2">
                    {analysis.paymentLanguageDetected ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    )}
                    <div>
                      <p className="text-sm font-medium">
                        {analysis.paymentLanguageDetected
                          ? "Payment language detected"
                          : "Payment confirmation was not clear"}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        This is a suggestion only. You remain responsible for confirming that payment cleared.
                      </p>
                    </div>
                  </div>
                </div>

                {analysis.missing.length > 0 && (
                  <div className="rounded-md border border-dashed border-border p-3" data-testid="list-missing-details">
                    <p className="rule-label">Details to verify</p>
                    <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                      {analysis.missing.map((item) => (
                        <li key={item} className="flex gap-2">
                          <span className="text-amber-600 dark:text-amber-400">•</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="draft-summary">Conversation summary</Label>
                  <Textarea
                    id="draft-summary"
                    className="min-h-28 resize-y text-sm"
                    value={draft.conversationSummary}
                    onChange={(event) => update("conversationSummary", event.target.value)}
                    data-testid="input-draft-summary"
                  />
                </div>
              </div>
            </Panel>

            <Panel
              title="3. Confirm and create the paid order"
              description="Fields remain editable. Creating this record is the only action that writes to HubSpot."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client name" id="full-name" value={draft.fullName} onChange={(v) => update("fullName", v)} required />
                <Field label="Marketplace username" id="marketplace-username" value={draft.marketplaceUsername} onChange={(v) => update("marketplaceUsername", v)} />
                <Field label="Email" id="email" value={draft.email} onChange={(v) => update("email", v)} type="email" />
                <Field label="Phone" id="phone" value={draft.phone} onChange={(v) => update("phone", v)} type="tel" />
                <div className="sm:col-span-2">
                  <Field label="Model or order description" id="product-name" value={draft.productName} onChange={(v) => update("productName", v)} required />
                </div>
                <Field label="Paid amount" id="amount" value={draft.amount} onChange={(v) => update("amount", v)} required inputMode="decimal" />
                <Field label="Country / region" id="country" value={draft.country} onChange={(v) => update("country", v)} />
                <div className="sm:col-span-2">
                  <Field label="Shipping address" id="address" value={draft.address} onChange={(v) => update("address", v)} />
                </div>
                <Field label="City" id="city" value={draft.city} onChange={(v) => update("city", v)} />
                <Field label="State / region" id="state" value={draft.state} onChange={(v) => update("state", v)} />
                <Field label="Postal code" id="postal-code" value={draft.postalCode} onChange={(v) => update("postalCode", v)} />
              </div>

              <label
                className={`mt-5 flex cursor-pointer items-start gap-3 rounded-md border p-3 ${
                  draft.paymentConfirmed ? "border-primary/35 bg-primary/5" : "border-border bg-muted/20"
                }`}
                data-testid="control-payment-confirmation"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={draft.paymentConfirmed}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, paymentConfirmed: event.target.checked }));
                    setCreated(null);
                  }}
                  data-testid="checkbox-payment-confirmed"
                />
                <span>
                  <span className="block text-sm font-medium">Payment has been confirmed</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Create this record only after you have verified the customer’s payment.
                  </span>
                </span>
              </label>

              <Button
                type="button"
                className="mt-4 w-full"
                onClick={createRecord}
                disabled={create.isPending || !draft.paymentConfirmed}
                data-testid="button-create-paid-order"
              >
                {create.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <PlusCircle className="mr-2 h-4 w-4" />
                )}
                Create paid Contact and Print Order
              </Button>

              {created && (
                <div
                  className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-4"
                  data-testid="panel-paid-order-created"
                >
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">Paid order created in HubSpot</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {created.dealName} was created in <strong>Deposit Received</strong> and associated
                        with a {created.contactStatus === "existing" ? "matching" : "new"} Contact.
                      </p>
                      <p className="mt-2 numeric text-xs text-muted-foreground">
                        Deal ID {created.dealId} · Contact ID {created.contactId}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button asChild size="sm" data-testid="button-paid-order-attach-plates">
                          <a href={`/#/prints?dealId=${encodeURIComponent(created.dealId)}`}>
                            Attach first plate
                          </a>
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </Panel>
          </section>
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
  inputMode,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  inputMode?: "decimal" | "email" | "tel" | "text";
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
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`input-${id}`}
      />
    </div>
  );
}
