import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { FileUp, Loader2, Ship, CheckCircle2, AlertTriangle, Copy, MessageSquareText, Mail, ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { labelsDealHref, queueDealHref, readHashQueryParam } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import {
  buyerTrackingEmailSubject,
  buyerTrackingMailtoHref,
  draftBuyerTrackingMessage,
} from "@shared/shipping-draft";
import { defaultLabelMatchDealIds } from "@shared/shipping-label-select";
import { ShippingEmailPreviewDialog } from "@/components/shipping-email-preview-dialog";
import { ShipEngineBuyPanel, ShipEngineLabelLink } from "@/components/shipengine-buy-panel";
import type { ShippingEmailTemplateInput } from "@shared/shipping-email-template";
import type { ProductionQueueResponse } from "@shared/schema";

type LabelFields = {
  trackingNumber: string | null;
  service: string | null;
  carrier: string | null;
  postageUsd: string | null;
  recipientName: string | null;
  clientName: string | null;
  recipientCity: string | null;
  recipientState: string | null;
  recipientPostalCode: string | null;
  warnings: string[];
};

type LabelMatch = {
  dealId: string;
  dealName: string;
  stage: string;
  contactName: string | null;
  amount: number;
  closed: boolean;
  score: number;
  reason: string;
};

type ParseResponse = {
  ok: true;
  fileName: string;
  fields: LabelFields;
  suggestedNotes: string;
  matches: LabelMatch[];
  alreadyAttachedDealIds?: string[];
  alreadyAttached?: {
    dealId: string;
    dealName: string | null;
    trackingNumber: string;
    notes: string;
    source: "local" | "hubspot";
    updatedAt: string | null;
  } | null;
};

type AttachedDraft = {
  dealIds: string[];
  dealName: string;
  dealNames: string[];
  contactName: string | null;
  contactEmail: string | null;
  trackingNumber: string;
  service: string | null;
  carrier: string | null;
  message: string;
  labelUrl: string | null;
};

/**
 * Buy labels via ShipEngine, or drop Pirate Ship / carrier PDFs → attach tracking.
 * Complete in HubSpot already means shipped — no separate Shipped board needed.
 */
export default function ShippingLabelsPage() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Labels unlocked",
    successDescription: "Buy ShipEngine labels or drop PDFs to pull tracking onto Print Orders.",
  });

  const [dragOver, setDragOver] = useState(false);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [tracking, setTracking] = useState("");
  const [notes, setNotes] = useState("");
  const [postage, setPostage] = useState("");
  const [messageChannel, setMessageChannel] = useState<"marketplace" | "offerup">("marketplace");
  const [selectedDealIds, setSelectedDealIds] = useState<string[]>([]);
  const [manualDealId, setManualDealId] = useState("");
  const [attachedDraft, setAttachedDraft] = useState<AttachedDraft | null>(null);
  const [emailPreviewOpen, setEmailPreviewOpen] = useState(false);
  const [prefillDealId, setPrefillDealId] = useState(() => readHashQueryParam("dealId")?.trim() || "");
  const [, setLocation] = useLocation();

  const hasPrefillDeal = Boolean(prefillDealId && /^[0-9]{1,20}$/.test(prefillDealId));

  const queueQuery = useQuery<{ ok: true } & ProductionQueueResponse>({
    queryKey: ["/api/production-queue", ownerCode, "labels-prefill"],
    enabled: isUnlocked && hasPrefillDeal,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/production-queue", undefined, { headers });
      return response.json();
    },
  });

  const prefillDeal = useMemo(() => {
    if (!hasPrefillDeal || !queueQuery.data) return null;
    const items = [
      ...(queueQuery.data.nextPrint ?? []),
      ...(queueQuery.data.inProduction ?? []),
      ...(queueQuery.data.shipReady ?? []),
      ...(queueQuery.data.blocked ?? []),
    ];
    return items.find((row) => row.dealId === prefillDealId) ?? null;
  }, [hasPrefillDeal, queueQuery.data, prefillDealId]);

  const prefillDealLabel = prefillDeal?.dealName?.trim() || (hasPrefillDeal ? `Order ···${prefillDealId.slice(-6)}` : "");

  function clearPrefillDeal() {
    setPrefillDealId("");
    setManualDealId("");
    setLocation(labelsDealHref());
  }

  useEffect(() => {
    const sync = () => {
      const id = readHashQueryParam("dealId")?.trim() || "";
      setPrefillDealId(id);
      if (id && /^[0-9]{1,20}$/.test(id)) {
        setManualDealId(id);
        setSelectedDealIds((prev) => (prev.includes(id) ? prev : prev.length === 0 ? [id] : prev));
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const alreadyAttachedIdSet = useMemo(
    () => new Set(parsed?.alreadyAttachedDealIds ?? (parsed?.alreadyAttached ? [parsed.alreadyAttached.dealId] : [])),
    [parsed],
  );

  const parseLabel = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const response = await apiRequest("POST", "/api/shipping-labels/parse", body, { headers });
      return (await response.json()) as ParseResponse;
    },
    onSuccess: (data) => {
      setAttachedDraft(null);
      setParsed(data);
      setTracking(data.fields.trackingNumber ?? "");
      setNotes(data.suggestedNotes || "");
      setPostage(data.fields.postageUsd ?? "");
      setManualDealId("");
      const defaults = defaultLabelMatchDealIds(data.matches);
      const seeded =
        defaults.length > 0
          ? defaults
          : data.alreadyAttached?.dealId
            ? [data.alreadyAttached.dealId]
            : prefillDealId && /^[0-9]{1,20}$/.test(prefillDealId)
              ? [prefillDealId]
              : [];
      setSelectedDealIds(seeded);
      const attachedIds = data.alreadyAttachedDealIds ?? (data.alreadyAttached ? [data.alreadyAttached.dealId] : []);
      const pendingDefaults = defaults.filter((id) => !attachedIds.includes(id));
      if (attachedIds.length > 0 && pendingDefaults.length === 0 && defaults.length > 0) {
        toast({
          title: "Already attached",
          description:
            attachedIds.length > 1
              ? `${data.fields.trackingNumber ?? "Tracking"} is already on all ${attachedIds.length} matching orders.`
              : data.alreadyAttached?.dealName
                ? `${data.alreadyAttached.trackingNumber} is on ${data.alreadyAttached.dealName} — no action needed.`
                : `${data.alreadyAttached?.trackingNumber ?? "Tracking"} is already saved — no action needed.`,
        });
      } else if (attachedIds.length > 0 && pendingDefaults.length > 0) {
        toast({
          title: "Shared box?",
          description: `Tracking is already on ${attachedIds.length} order(s). ${pendingDefaults.length} matching order(s) still need it — keep them selected to attach.`,
        });
      } else {
        toast({
          title: "Label read",
          description:
            defaults.length > 1
              ? `Tracking ${data.fields.trackingNumber ?? ""} · ${defaults.length} orders selected (same client)`
              : data.fields.trackingNumber
                ? `Tracking ${data.fields.trackingNumber}`
                : "Check the fields and pick the matching order(s).",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Could not read label",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 220),
        variant: "destructive",
      });
    },
  });

  const attach = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        "/api/shipping-labels/attach",
        {
          dealIds: selectedDealIds,
          trackingNumber: tracking.trim(),
          notes: notes.trim(),
          postageUsd: postage.trim(),
          messageChannel,
          packingDone: true,
          labelBought: true,
        },
        { headers },
      );
      return (await response.json()) as {
        ok: true;
        duplicate?: boolean;
        message?: string;
        attachedDealIds?: string[];
        skippedDealIds?: string[];
        contact?: { id: string | null; name: string; email: string };
        alreadyAttached?: { dealId: string; trackingNumber: string };
        stageMoves?: Array<{
          dealId: string;
          ok: boolean;
          dryRun?: boolean;
          stageLabel?: string;
          error?: string;
        }>;
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deal-ops"] });

      if (data.duplicate) {
        toast({
          title: "Already attached",
          description: data.message ?? "This tracking is already saved — nothing else to do.",
        });
        setParsed(null);
        setTracking("");
        setNotes("");
        setPostage("");
        setSelectedDealIds([]);
        setManualDealId("");
        setAttachedDraft(null);
        return;
      }

      const attachedIds = data.attachedDealIds?.length ? data.attachedDealIds : selectedDealIds;
      const selectedMatches = (parsed?.matches ?? []).filter((row) => attachedIds.includes(row.dealId));
      const dealNames =
        selectedMatches.length > 0
          ? selectedMatches.map((row) => row.dealName)
          : attachedIds.map((id) => `Deal ${id}`);
      const primaryMatch = selectedMatches[0] ?? null;
      const contactName =
        data.contact?.name?.trim() ||
        primaryMatch?.contactName ||
        parsed?.fields.clientName ||
        parsed?.fields.recipientName ||
        null;
      const contactEmail = data.contact?.email?.trim() || null;
      const message = draftBuyerTrackingMessage({
        contactName,
        dealName: primaryMatch?.dealName ?? dealNames[0] ?? null,
        dealNames,
        trackingNumber: tracking.trim(),
        service: parsed?.fields.service ?? null,
        carrier: parsed?.fields.carrier ?? null,
      });
      setAttachedDraft({
        dealIds: attachedIds,
        dealName: primaryMatch?.dealName ?? dealNames[0] ?? `Deal ${attachedIds[0]}`,
        dealNames,
        contactName,
        contactEmail,
        trackingNumber: tracking.trim(),
        service: parsed?.fields.service ?? null,
        carrier: parsed?.fields.carrier ?? null,
        message,
        labelUrl: null,
      });
      const skipCount = data.skippedDealIds?.length ?? 0;
      const completed = (data.stageMoves ?? []).filter((row) => row.ok);
      const stageHint = completed[0]?.stageLabel
        ? ` · ${completed.length > 1 ? `${completed.length} orders` : "order"} → ${completed[0].stageLabel}`
        : data.stageMoves?.some((row) => !row.ok)
          ? " · stage move failed"
          : "";
      toast({
        title: attachedIds.length > 1 ? `Tracking on ${attachedIds.length} orders` : "Tracking attached",
        description: contactEmail
          ? `Draft ready for ${contactEmail}${stageHint}${skipCount ? ` · ${skipCount} already had it` : ""}`
          : `Draft ready — copy for Marketplace.${stageHint}${skipCount ? ` (${skipCount} already had tracking)` : ""}`,
      });
      setParsed(null);
      setTracking("");
      setNotes("");
      setPostage("");
      setSelectedDealIds([]);
      setManualDealId("");
    },
    onError: (error: Error) => {
      toast({
        title: "Could not attach tracking",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 220),
        variant: "destructive",
      });
    },
  });

  const selectedMatches = useMemo(
    () => (parsed?.matches ?? []).filter((row) => selectedDealIds.includes(row.dealId)),
    [parsed, selectedDealIds],
  );
  const primaryDealId = selectedDealIds[0] ?? "";
  const selectedDealNames = useMemo(() => {
    if (selectedMatches.length > 0) return selectedMatches.map((row) => row.dealName);
    return selectedDealIds.map((id) => `Deal ${id}`);
  }, [selectedMatches, selectedDealIds]);

  const pendingSelectedIds = useMemo(
    () => selectedDealIds.filter((id) => !alreadyAttachedIdSet.has(id)),
    [selectedDealIds, alreadyAttachedIdSet],
  );
  const allSelectedAlreadyAttached =
    selectedDealIds.length > 0 && pendingSelectedIds.length === 0;

  const contactLookup = useQuery<{
    ok: true;
    contact: { id: string | null; name: string; email: string };
  }>({
    queryKey: ["/api/shipping-labels/contact", primaryDealId, ownerCode],
    enabled: isUnlocked && /^[0-9]{1,20}$/.test(primaryDealId) && Boolean(parsed),
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/shipping-labels/contact/${encodeURIComponent(primaryDealId)}`,
        undefined,
        { headers },
      );
      return response.json();
    },
  });

  const hubspotEmail = contactLookup.data?.contact.email?.trim() || "";
  const hubspotContactName = contactLookup.data?.contact.name?.trim() || "";

  const liveDraft = useMemo(() => {
    if (!tracking.trim()) return "";
    return draftBuyerTrackingMessage({
      contactName:
        hubspotContactName ||
        selectedMatches[0]?.contactName ||
        parsed?.fields.clientName ||
        parsed?.fields.recipientName ||
        null,
      dealName: selectedMatches[0]?.dealName ?? null,
      dealNames: selectedDealNames,
      trackingNumber: tracking.trim(),
      service: parsed?.fields.service ?? null,
      carrier: parsed?.fields.carrier ?? null,
    });
  }, [tracking, selectedMatches, selectedDealNames, parsed, hubspotContactName]);

  const previewMailto = useMemo(() => {
    if (!hubspotEmail || !liveDraft) return null;
    return buyerTrackingMailtoHref({
      email: hubspotEmail,
      subject: buyerTrackingEmailSubject(selectedMatches[0]?.dealName, selectedDealIds.length),
      body: liveDraft,
    });
  }, [hubspotEmail, liveDraft, selectedMatches, selectedDealIds.length]);

  const attachedMailto = useMemo(() => {
    if (!attachedDraft?.contactEmail) return null;
    return buyerTrackingMailtoHref({
      email: attachedDraft.contactEmail,
      subject: buyerTrackingEmailSubject(attachedDraft.dealName, attachedDraft.dealIds.length),
      body: attachedDraft.message,
    });
  }, [attachedDraft]);

  const emailTemplateInput = useMemo((): ShippingEmailTemplateInput | null => {
    const trackingNumber = attachedDraft?.trackingNumber || tracking.trim();
    if (!trackingNumber) return null;
    return {
      contactName:
        attachedDraft?.contactName ||
        hubspotContactName ||
        selectedMatches[0]?.contactName ||
        parsed?.fields.clientName ||
        parsed?.fields.recipientName ||
        null,
      dealName: attachedDraft?.dealName || selectedMatches[0]?.dealName || null,
      trackingNumber,
      service: attachedDraft?.service || parsed?.fields.service || null,
      carrier: attachedDraft?.carrier || parsed?.fields.carrier || null,
    };
  }, [attachedDraft, tracking, hubspotContactName, selectedMatches, parsed]);

  const emailDialogContact = attachedDraft?.contactEmail || hubspotEmail || null;

  function toggleDealId(dealId: string) {
    setSelectedDealIds((prev) =>
      prev.includes(dealId) ? prev.filter((id) => id !== dealId) : [...prev, dealId],
    );
  }

  function clearConfirmPanel() {
    setParsed(null);
    setSelectedDealIds([]);
    setManualDealId("");
  }

  function addManualDealId() {
    const id = manualDealId.trim();
    if (!/^[0-9]{1,20}$/.test(id)) {
      toast({
        title: "Invalid deal id",
        description: "Paste a HubSpot deal id (digits only).",
        variant: "destructive",
      });
      return;
    }
    setSelectedDealIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setManualDealId("");
  }

  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: "Paste into Marketplace or your buyer chat." });
    } catch {
      toast({
        title: "Could not copy",
        description: "Select the draft text and copy manually.",
        variant: "destructive",
      });
    }
  }

  function onFiles(files: FileList | File[] | null) {
    const file = files?.[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      toast({
        title: "PDF only",
        description: "Drop a shipping label PDF from Pirate Ship or the carrier.",
        variant: "destructive",
      });
      return;
    }
    parseLabel.mutate(file);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Labels"
        subtitle={
          hasPrefillDeal
            ? `Buying or attaching a label for ${prefillDealLabel}.`
            : "Buy a ShipEngine label or drop a PDF — attach tracking to one or more Print Orders when they ship in the same box."
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock Labels"
            description="Owner code required to buy labels, read PDFs, and write tracking onto HubSpot deals."
            buttonLabel="Unlock Labels"
            testIdPrefix="labels"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : (
          <>
            {hasPrefillDeal ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-3"
                data-testid="panel-labels-prefill"
              >
                <div className="min-w-0">
                  <p className="rule-label mb-0.5">From Queue</p>
                  <p className="truncate text-sm font-semibold text-foreground" data-testid="text-labels-prefill-name">
                    {prefillDealLabel}
                  </p>
                  {prefillDeal?.contactName ? (
                    <p className="truncate text-xs text-muted-foreground">{prefillDeal.contactName}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button asChild size="sm" variant="outline" data-testid="button-labels-open-queue">
                    <Link href={queueDealHref(prefillDealId)}>
                      <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                      Queue
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={clearPrefillDeal}
                    data-testid="button-labels-clear-prefill"
                    aria-label="Clear selected order"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}

            <ShipEngineBuyPanel
              headers={headers}
              ownerCode={ownerCode}
              isUnlocked={isUnlocked}
              prefillDealId={prefillDealId}
              messageChannel={messageChannel}
              onPurchased={(result) => {
                const message = draftBuyerTrackingMessage({
                  contactName: result.contactName,
                  dealName: result.dealName,
                  dealNames: [result.dealName],
                  trackingNumber: result.trackingNumber,
                  service: result.service,
                  carrier: result.carrier,
                });
                setAttachedDraft({
                  dealIds: result.dealIds,
                  dealName: result.dealName,
                  dealNames: [result.dealName],
                  contactName: result.contactName,
                  contactEmail: result.contactEmail,
                  trackingNumber: result.trackingNumber,
                  service: result.service,
                  carrier: result.carrier,
                  message,
                  labelUrl: result.labelUrl,
                });
                setParsed(null);
                setTracking("");
                setNotes("");
                setPostage("");
                setSelectedDealIds([]);
                setManualDealId("");
              }}
            />

            <Panel
              title="Or drop a shipping label PDF"
              description="Pirate Ship / carrier PDF exports still work. Nothing is saved until you confirm the order below."
              testId="panel-labels-drop"
            >
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                data-testid="input-shipping-label-file"
                onChange={(event) => {
                  onFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className={cn(
                  "glance-item glance-in w-full flex-col items-stretch gap-2 border-dashed py-10 text-center",
                  dragOver && "border-primary bg-primary/5",
                )}
                data-tone="good"
                data-testid="button-shipping-label-dropzone"
                disabled={parseLabel.isPending}
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  onFiles(event.dataTransfer.files);
                }}
              >
                {parseLabel.isPending ? (
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                ) : (
                  <FileUp className="mx-auto h-6 w-6 text-primary" />
                )}
                <p className="text-sm font-semibold">
                  {parseLabel.isPending ? "Reading label…" : "Drop label PDF here"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Completing an order in HubSpot is enough for “shipped.” Pirate Ship PDFs are often image-only — we still read tracking + client from the file name when needed.
                </p>
              </button>
            </Panel>

            {attachedDraft ? (
              <Panel
                title="Message the buyer"
                description={
                  attachedDraft.dealIds.length > 1
                    ? `${attachedDraft.dealIds.length} orders · shared tracking saved — copy this into Marketplace (not sent automatically).`
                    : `${attachedDraft.dealName} · tracking saved — copy this into Marketplace (not sent automatically).`
                }
                testId="panel-labels-buyer-draft"
              >
                <div className="glance-item glance-in flex-col items-stretch gap-3" data-tone="good">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    <MessageSquareText className="h-4 w-4 text-primary" />
                    Draft ready
                    <StatusPill
                      tone="good"
                      icon={CheckCircle2}
                      label={
                        attachedDraft.dealIds.length > 1
                          ? `Tracking on ${attachedDraft.dealIds.length} orders`
                          : "Tracking attached"
                      }
                    />
                    {attachedDraft.contactEmail ? (
                      <StatusPill tone="neutral" icon={Mail} label={attachedDraft.contactEmail} />
                    ) : (
                      <StatusPill tone="warn" icon={AlertTriangle} label="No HubSpot email" />
                    )}
                  </div>
                  {attachedDraft.dealNames.length > 1 ? (
                    <p className="text-xs text-muted-foreground">{attachedDraft.dealNames.join(" · ")}</p>
                  ) : null}
                  <pre
                    className="whitespace-pre-wrap rounded-md border border-border/80 bg-muted/35 px-3 py-2.5 font-sans text-sm leading-relaxed text-foreground"
                    data-testid="text-buyer-tracking-draft"
                  >
                    {attachedDraft.message}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    {attachedDraft.labelUrl ? <ShipEngineLabelLink url={attachedDraft.labelUrl} /> : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEmailPreviewOpen(true)}
                      data-testid="button-open-email-template-attached"
                    >
                      <Mail className="mr-2 h-3.5 w-3.5" />
                      Shipped email
                    </Button>
                    {attachedMailto ? (
                      <Button asChild size="sm" data-testid="button-email-buyer-draft">
                        <a href={attachedMailto}>
                          <Mail className="mr-2 h-3.5 w-3.5" />
                          Open mail app
                        </a>
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant={attachedMailto ? "outline" : "default"}
                      onClick={() => void copyMessage(attachedDraft.message)}
                      data-testid="button-copy-buyer-draft"
                    >
                      <Copy className="mr-2 h-3.5 w-3.5" />
                      Copy message
                    </Button>
                    {attachedDraft.dealIds.slice(0, 3).map((id) => (
                      <Button key={id} asChild size="sm" variant="outline">
                        <Link href={queueDealHref(id)}>
                          {attachedDraft.dealIds.length > 1 ? `Queue · ${id.slice(-4)}` : "Open in Queue"}
                        </Link>
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => setAttachedDraft(null)}>
                      Done
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {attachedDraft.contactEmail
                      ? "Email buyer opens your mail app with the HubSpot contact address and this draft filled in. Print Ops does not send email by itself yet."
                      : "No email on the HubSpot contact — copy for Marketplace, or add email on the contact and try again."}
                  </p>
                </div>
              </Panel>
            ) : null}

            {parsed ? (
              <Panel
                title="Confirm & attach"
                description={parsed.fileName}
                testId="panel-labels-confirm"
              >
                {alreadyAttachedIdSet.size > 0 ? (
                  <div
                    className="glance-item mb-3 flex-col items-stretch gap-2"
                    data-tone={allSelectedAlreadyAttached ? "good" : "warn"}
                    data-testid="panel-label-already-attached"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      {allSelectedAlreadyAttached
                        ? "Already on every selected order"
                        : `Already on ${alreadyAttachedIdSet.size} order(s) — can still attach to others`}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Tracking{" "}
                      <span className="font-medium text-foreground">
                        {parsed.alreadyAttached?.trackingNumber ?? tracking}
                      </span>
                      {parsed.alreadyAttached?.dealName
                        ? <>
                            {" "}
                            is already on{" "}
                            <span className="font-medium text-foreground">
                              {parsed.alreadyAttached.dealName}
                            </span>
                            {alreadyAttachedIdSet.size > 1 ? ` (+${alreadyAttachedIdSet.size - 1} more)` : ""}.
                          </>
                        : " is already saved on at least one Print Order."}
                      {pendingSelectedIds.length > 0
                        ? " Keep the other matching orders selected to put the same tracking on the shared box."
                        : " Re-uploading won’t change those deals."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {[...(parsed.alreadyAttachedDealIds ?? (parsed.alreadyAttached ? [parsed.alreadyAttached.dealId] : []))]
                        .slice(0, 3)
                        .map((id) => (
                          <Button key={id} asChild size="sm" variant="outline">
                            <Link href={queueDealHref(id)}>Queue · {id.slice(-4)}</Link>
                          </Button>
                        ))}
                      <Button size="sm" variant="ghost" onClick={clearConfirmPanel}>
                        Clear
                      </Button>
                    </div>
                  </div>
                ) : null}
                {parsed.fields.warnings.length > 0 ? (
                  <ul className="mb-3 space-y-1">
                    {parsed.fields.warnings.map((warning) => (
                      <li key={warning} className="flex items-start gap-2 text-xs text-chart-4">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {warning}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="label-tracking">Tracking number</Label>
                    <Input
                      id="label-tracking"
                      value={tracking}
                      onChange={(event) => setTracking(event.target.value)}
                      data-testid="input-label-tracking"
                    />
                  </div>
                  <div>
                    <Label htmlFor="label-postage">Postage (optional)</Label>
                    <Input
                      id="label-postage"
                      value={postage}
                      onChange={(event) => setPostage(event.target.value)}
                      placeholder="0.00"
                      data-testid="input-label-postage"
                    />
                  </div>
                  <div>
                    <Label htmlFor="label-message-channel">Buyer chat</Label>
                    <select
                      id="label-message-channel"
                      value={messageChannel}
                      onChange={(event) =>
                        setMessageChannel(event.target.value === "offerup" ? "offerup" : "marketplace")
                      }
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                      data-testid="select-label-message-channel"
                    >
                      <option value="marketplace">Facebook Marketplace</option>
                      <option value="offerup">OfferUp</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="label-notes">Ship notes</Label>
                    <Input
                      id="label-notes"
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      data-testid="input-label-notes"
                    />
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {parsed.fields.service ? (
                    <StatusPill tone="neutral" icon={Ship} label={parsed.fields.service} />
                  ) : parsed.fields.carrier ? (
                    <StatusPill tone="neutral" icon={Ship} label={parsed.fields.carrier} />
                  ) : null}
                  {parsed.fields.clientName ? (
                    <StatusPill tone="good" icon={CheckCircle2} label={`Client ${parsed.fields.clientName}`} />
                  ) : null}
                  {parsed.fields.recipientName &&
                  parsed.fields.recipientName !== parsed.fields.clientName ? (
                    <StatusPill tone="neutral" icon={Ship} label={`Ship-to ${parsed.fields.recipientName}`} />
                  ) : parsed.fields.recipientName && !parsed.fields.clientName ? (
                    <StatusPill tone="good" icon={CheckCircle2} label={parsed.fields.recipientName} />
                  ) : null}
                  {parsed.fields.recipientCity ? (
                    <span>
                      {parsed.fields.recipientCity}
                      {parsed.fields.recipientState ? `, ${parsed.fields.recipientState}` : ""}{" "}
                      {parsed.fields.recipientPostalCode ?? ""}
                    </span>
                  ) : null}
                </div>

                <div className="mt-4 space-y-2">
                  <p className="text-sm font-semibold">
                    Match to Print Order
                    {selectedDealIds.length > 1 ? (
                      <span className="ml-2 font-normal text-muted-foreground">
                        · {selectedDealIds.length} selected (same tracking / box)
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Select every order in the box. Same-client matches are pre-selected when we can tell.
                  </p>
                  {parsed.matches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No automatic match — paste HubSpot deal id(s) below, or open{" "}
                      <Link href="/deals" className="text-primary hover:underline">
                        Orders
                      </Link>{" "}
                      and use Ops → Save tracking.
                    </p>
                  ) : (
                    <ul className="glance-list">
                      {parsed.matches.map((match) => {
                        const selected = selectedDealIds.includes(match.dealId);
                        const alreadyOn = alreadyAttachedIdSet.has(match.dealId);
                        return (
                          <li key={match.dealId}>
                            <button
                              type="button"
                              className="glance-item w-full text-left"
                              data-tone={
                                alreadyOn ? "good" : match.closed ? "good" : match.score >= 70 ? "warn" : undefined
                              }
                              data-testid={`button-label-match-${match.dealId}`}
                              onClick={() => toggleDealId(match.dealId)}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold">{match.dealName}</span>
                                <span className="text-xs text-muted-foreground">
                                  {match.stage}
                                  {match.closed ? " · completed" : ""}
                                  {match.contactName ? ` · ${match.contactName}` : ""} · {formatMoney(match.amount)}
                                </span>
                                <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
                                  {match.reason}
                                  {alreadyOn ? " · tracking already on this order" : ""}
                                </span>
                              </span>
                              {selected ? (
                                <StatusPill
                                  tone="good"
                                  icon={CheckCircle2}
                                  label={alreadyOn ? "On + selected" : "Selected"}
                                />
                              ) : alreadyOn ? (
                                <StatusPill tone="neutral" icon={CheckCircle2} label="Already on" />
                              ) : (
                                <span className="text-xs text-muted-foreground">Score {match.score}</span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="flex flex-wrap items-end gap-2 pt-1">
                    <div className="min-w-[12rem] flex-1">
                      <Label htmlFor="label-deal-id">Add deal id</Label>
                      <Input
                        id="label-deal-id"
                        value={manualDealId}
                        onChange={(event) => setManualDealId(event.target.value.trim())}
                        placeholder="HubSpot deal id"
                        data-testid="input-label-deal-id"
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addManualDealId();
                          }
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={addManualDealId}
                      data-testid="button-label-add-deal-id"
                    >
                      Add
                    </Button>
                  </div>
                  {selectedDealIds.some((id) => !parsed.matches.some((m) => m.dealId === id)) ? (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {selectedDealIds
                        .filter((id) => !parsed.matches.some((m) => m.dealId === id))
                        .map((id) => (
                          <li key={id} className="flex items-center gap-2">
                            <span>Also selected: deal {id}</span>
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              onClick={() => toggleDealId(id)}
                            >
                              remove
                            </button>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </div>

                {liveDraft ? (
                  <div className="mt-4 space-y-2">
                    <p className="text-sm font-semibold">Buyer message preview</p>
                    <div
                      className="glance-item flex-col items-stretch gap-2"
                      data-tone="good"
                      data-testid="panel-labels-draft-preview"
                    >
                      {hubspotEmail ? (
                        <p className="text-xs text-muted-foreground">
                          HubSpot contact: <span className="font-medium text-foreground">{hubspotEmail}</span>
                        </p>
                      ) : contactLookup.isFetching ? (
                        <p className="text-xs text-muted-foreground">Looking up HubSpot email…</p>
                      ) : primaryDealId ? (
                        <p className="text-xs text-muted-foreground">No email on the linked HubSpot contact.</p>
                      ) : null}
                      <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">
                        {liveDraft}
                      </pre>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setEmailPreviewOpen(true)}
                          data-testid="button-open-email-template-preview"
                        >
                          <Mail className="mr-2 h-3.5 w-3.5" />
                          Shipped email
                        </Button>
                        {previewMailto ? (
                          <Button asChild type="button" size="sm" data-testid="button-email-draft-preview">
                            <a href={previewMailto}>
                              <Mail className="mr-2 h-3.5 w-3.5" />
                              Open mail app
                            </a>
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="w-fit"
                          onClick={() => void copyMessage(liveDraft)}
                          data-testid="button-copy-draft-preview"
                        >
                          <Copy className="mr-2 h-3.5 w-3.5" />
                          Copy draft
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={
                      allSelectedAlreadyAttached ||
                      attach.isPending ||
                      !tracking.trim() ||
                      selectedDealIds.length === 0 ||
                      !selectedDealIds.every((id) => /^[0-9]{1,20}$/.test(id))
                    }
                    onClick={() => attach.mutate()}
                    data-testid="button-label-attach"
                  >
                    {attach.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    {allSelectedAlreadyAttached
                      ? "Already attached"
                      : pendingSelectedIds.length > 1
                        ? `Attach tracking to ${pendingSelectedIds.length} orders`
                        : pendingSelectedIds.length === 1 && selectedMatches[0]
                          ? `Attach tracking · ${selectedMatches[0].dealName.slice(0, 28)}`
                          : selectedDealIds.length > 1
                            ? `Attach tracking to ${selectedDealIds.length} orders`
                            : "Attach tracking"}
                  </Button>
                  {primaryDealId ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={queueDealHref(primaryDealId)}>Open in Queue</Link>
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={clearConfirmPanel}>
                    Clear
                  </Button>
                </div>
              </Panel>
            ) : null}
          </>
        )}
      </div>

      <ShippingEmailPreviewDialog
        open={emailPreviewOpen}
        onOpenChange={setEmailPreviewOpen}
        input={emailTemplateInput}
        contactEmail={emailDialogContact}
        onCopyText={(text) => void copyMessage(text)}
      />
    </div>
  );
}
