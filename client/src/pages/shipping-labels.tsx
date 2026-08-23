import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { FileUp, Loader2, Ship, CheckCircle2, AlertTriangle, Copy, MessageSquareText, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { queueDealHref } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import {
  buyerTrackingEmailSubject,
  buyerTrackingMailtoHref,
  draftBuyerTrackingMessage,
} from "@shared/shipping-draft";

type LabelFields = {
  trackingNumber: string | null;
  service: string | null;
  carrier: string | null;
  postageUsd: string | null;
  recipientName: string | null;
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
  dealId: string;
  dealName: string;
  contactName: string | null;
  contactEmail: string | null;
  trackingNumber: string;
  service: string | null;
  carrier: string | null;
  message: string;
};

/**
 * Drop Pirate Ship / carrier label PDFs → extract tracking → confirm Print Order.
 * Complete in HubSpot already means shipped — no separate Shipped board needed.
 */
export default function ShippingLabelsPage() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Labels unlocked",
    successDescription: "Drop label PDFs to pull tracking onto Print Orders.",
  });

  const [dragOver, setDragOver] = useState(false);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [tracking, setTracking] = useState("");
  const [notes, setNotes] = useState("");
  const [postage, setPostage] = useState("");
  const [dealId, setDealId] = useState("");
  const [attachedDraft, setAttachedDraft] = useState<AttachedDraft | null>(null);

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
      setDealId(data.alreadyAttached?.dealId ?? data.matches[0]?.dealId ?? "");
      if (data.alreadyAttached) {
        toast({
          title: "Already attached",
          description: data.alreadyAttached.dealName
            ? `${data.alreadyAttached.trackingNumber} is on ${data.alreadyAttached.dealName} — no action needed.`
            : `${data.alreadyAttached.trackingNumber} is already saved — no action needed.`,
        });
      } else {
        toast({
          title: "Label read",
          description: data.fields.trackingNumber
            ? `Tracking ${data.fields.trackingNumber}`
            : "Check the fields and pick the matching order.",
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
          dealId,
          trackingNumber: tracking.trim(),
          notes: notes.trim(),
          postageUsd: postage.trim(),
          packingDone: true,
          labelBought: true,
        },
        { headers },
      );
      return (await response.json()) as {
        ok: true;
        duplicate?: boolean;
        message?: string;
        contact?: { id: string | null; name: string; email: string };
        alreadyAttached?: { dealId: string; trackingNumber: string };
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
        setDealId("");
        setAttachedDraft(null);
        return;
      }

      const match = parsed?.matches.find((row) => row.dealId === dealId) ?? null;
      const contactName =
        data.contact?.name?.trim() ||
        match?.contactName ||
        parsed?.fields.recipientName ||
        null;
      const contactEmail = data.contact?.email?.trim() || null;
      const message = draftBuyerTrackingMessage({
        contactName,
        dealName: match?.dealName ?? null,
        trackingNumber: tracking.trim(),
        service: parsed?.fields.service ?? null,
        carrier: parsed?.fields.carrier ?? null,
      });
      setAttachedDraft({
        dealId,
        dealName: match?.dealName ?? `Deal ${dealId}`,
        contactName,
        contactEmail,
        trackingNumber: tracking.trim(),
        service: parsed?.fields.service ?? null,
        carrier: parsed?.fields.carrier ?? null,
        message,
      });
      toast({
        title: "Tracking attached",
        description: contactEmail
          ? `Draft ready for ${contactEmail}`
          : "Draft ready — no HubSpot email on this contact; copy for Marketplace.",
      });
      setParsed(null);
      setTracking("");
      setNotes("");
      setPostage("");
      setDealId("");
    },
    onError: (error: Error) => {
      toast({
        title: "Could not attach tracking",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 220),
        variant: "destructive",
      });
    },
  });

  const selected = useMemo(
    () => parsed?.matches.find((row) => row.dealId === dealId) ?? null,
    [parsed, dealId],
  );

  const contactLookup = useQuery<{
    ok: true;
    contact: { id: string | null; name: string; email: string };
  }>({
    queryKey: ["/api/shipping-labels/contact", dealId, ownerCode],
    enabled: isUnlocked && /^[0-9]{1,20}$/.test(dealId) && Boolean(parsed),
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/shipping-labels/contact/${encodeURIComponent(dealId)}`,
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
      contactName: hubspotContactName || selected?.contactName || parsed?.fields.recipientName || null,
      dealName: selected?.dealName ?? null,
      trackingNumber: tracking.trim(),
      service: parsed?.fields.service ?? null,
      carrier: parsed?.fields.carrier ?? null,
    });
  }, [tracking, selected, parsed, hubspotContactName]);

  const previewMailto = useMemo(() => {
    if (!hubspotEmail || !liveDraft) return null;
    return buyerTrackingMailtoHref({
      email: hubspotEmail,
      subject: buyerTrackingEmailSubject(selected?.dealName),
      body: liveDraft,
    });
  }, [hubspotEmail, liveDraft, selected?.dealName]);

  const attachedMailto = useMemo(() => {
    if (!attachedDraft?.contactEmail) return null;
    return buyerTrackingMailtoHref({
      email: attachedDraft.contactEmail,
      subject: buyerTrackingEmailSubject(attachedDraft.dealName),
      body: attachedDraft.message,
    });
  }, [attachedDraft]);

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
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Labels"
        subtitle="Drop a shipping label PDF — we pull tracking, service, and postage, then attach it to the matching Print Order (including Completed)."
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock Labels"
            description="Owner code required to read label PDFs and write tracking onto HubSpot deals."
            value={unlock.code}
            onChange={unlock.setCode}
            onSubmit={unlock.submit}
            pending={unlock.pending}
            error={unlock.error}
          />
        ) : (
          <>
            <Panel
              title="Drop shipping label"
              description="Pirate Ship / USPS PDF exports work best. Nothing is saved until you confirm the order below."
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
                description={`${attachedDraft.dealName} · tracking saved — copy this into Marketplace (not sent automatically).`}
                testId="panel-labels-buyer-draft"
              >
                <div className="glance-item glance-in flex-col items-stretch gap-3" data-tone="good">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    <MessageSquareText className="h-4 w-4 text-primary" />
                    Draft ready
                    <StatusPill tone="good" icon={CheckCircle2} label="Tracking attached" />
                    {attachedDraft.contactEmail ? (
                      <StatusPill tone="neutral" icon={Mail} label={attachedDraft.contactEmail} />
                    ) : (
                      <StatusPill tone="warn" icon={AlertTriangle} label="No HubSpot email" />
                    )}
                  </div>
                  <pre
                    className="whitespace-pre-wrap rounded-md border border-border/80 bg-muted/35 px-3 py-2.5 font-sans text-sm leading-relaxed text-foreground"
                    data-testid="text-buyer-tracking-draft"
                  >
                    {attachedDraft.message}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    {attachedMailto ? (
                      <Button asChild size="sm" data-testid="button-email-buyer-draft">
                        <a href={attachedMailto}>
                          <Mail className="mr-2 h-3.5 w-3.5" />
                          Email buyer
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
                    <Button asChild size="sm" variant="outline">
                      <Link href={queueDealHref(attachedDraft.dealId)}>Open in Queue</Link>
                    </Button>
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
                {parsed.alreadyAttached ? (
                  <div
                    className="glance-item mb-3 flex-col items-stretch gap-2"
                    data-tone="good"
                    data-testid="panel-label-already-attached"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      Already attached — no action needed
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Tracking{" "}
                      <span className="font-medium text-foreground">
                        {parsed.alreadyAttached.trackingNumber}
                      </span>{" "}
                      is already on{" "}
                      <span className="font-medium text-foreground">
                        {parsed.alreadyAttached.dealName || `deal ${parsed.alreadyAttached.dealId}`}
                      </span>
                      . Re-uploading won’t change anything.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={queueDealHref(parsed.alreadyAttached.dealId)}>Open in Queue</Link>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setParsed(null);
                          setDealId("");
                        }}
                      >
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
                  {parsed.fields.recipientName ? (
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
                  <p className="text-sm font-semibold">Match to Print Order</p>
                  {parsed.matches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No automatic match — paste the HubSpot deal id below, or open{" "}
                      <Link href="/deals" className="text-primary hover:underline">
                        Orders
                      </Link>{" "}
                      and use Ops → Save tracking.
                    </p>
                  ) : (
                    <ul className="glance-list">
                      {parsed.matches.map((match) => (
                        <li key={match.dealId}>
                          <button
                            type="button"
                            className="glance-item w-full text-left"
                            data-tone={match.closed ? "good" : match.score >= 70 ? "warn" : undefined}
                            data-testid={`button-label-match-${match.dealId}`}
                            onClick={() => setDealId(match.dealId)}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold">{match.dealName}</span>
                              <span className="text-xs text-muted-foreground">
                                {match.stage}
                                {match.closed ? " · completed" : ""}
                                {match.contactName ? ` · ${match.contactName}` : ""} · {formatMoney(match.amount)}
                              </span>
                              <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">{match.reason}</span>
                            </span>
                            {dealId === match.dealId ? (
                              <StatusPill tone="good" icon={CheckCircle2} label="Selected" />
                            ) : (
                              <span className="text-xs text-muted-foreground">Score {match.score}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="pt-1">
                    <Label htmlFor="label-deal-id">Deal id</Label>
                    <Input
                      id="label-deal-id"
                      value={dealId}
                      onChange={(event) => setDealId(event.target.value.trim())}
                      placeholder="HubSpot deal id"
                      data-testid="input-label-deal-id"
                    />
                  </div>
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
                      ) : dealId ? (
                        <p className="text-xs text-muted-foreground">No email on the linked HubSpot contact.</p>
                      ) : null}
                      <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">
                        {liveDraft}
                      </pre>
                      <div className="flex flex-wrap gap-2">
                        {previewMailto ? (
                          <Button asChild type="button" size="sm" data-testid="button-email-draft-preview">
                            <a href={previewMailto}>
                              <Mail className="mr-2 h-3.5 w-3.5" />
                              Email buyer
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
                      Boolean(parsed.alreadyAttached) ||
                      attach.isPending ||
                      !tracking.trim() ||
                      !/^[0-9]{1,20}$/.test(dealId)
                    }
                    onClick={() => attach.mutate()}
                    data-testid="button-label-attach"
                  >
                    {attach.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    {parsed.alreadyAttached
                      ? "Already attached"
                      : `Attach tracking${selected ? ` · ${selected.dealName.slice(0, 28)}` : ""}`}
                  </Button>
                  {dealId ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={queueDealHref(dealId)}>Open in Queue</Link>
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setParsed(null);
                      setDealId("");
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </Panel>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
