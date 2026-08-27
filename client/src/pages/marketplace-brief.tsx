import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { Loader2, MessageSquareText, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";

type BriefAction = {
  id: string;
  label: string;
  href?: string;
  kind: "reply" | "ops" | "info";
};

type ThreadBrief = {
  id: string;
  title: string;
  unread: boolean;
  status: string;
  statusLabel: string;
  priority: number;
  why: string[];
  nextActions: BriefAction[];
  draftReply: string | null;
  signals: {
    paymentLanguageDetected: boolean;
    hasAmount: boolean;
    hasAddress: boolean;
    hasEmail: boolean;
    lastSpeaker: string;
    preview: string;
  };
};

type InboxBrief = {
  generatedAt: string;
  threadCount: number;
  headline: string;
  doFirst: ThreadBrief[];
  then: ThreadBrief[];
  waiting: ThreadBrief[];
  threads: ThreadBrief[];
};

function statusTone(status: string): "good" | "warn" | "bad" | "neutral" {
  if (status === "your_turn" || status === "paid_needs_details") return "bad";
  if (status === "ready_to_book" || status === "awaiting_payment" || status === "stale") return "warn";
  if (status === "done") return "good";
  return "neutral";
}

function ThreadCard({ thread }: { thread: ThreadBrief }) {
  const [showDraft, setShowDraft] = useState(false);
  return (
    <article
      className="rounded-md border border-border bg-card px-3 py-3"
      data-testid={`marketplace-brief-thread-${thread.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{thread.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{thread.signals.preview || "No preview"}</p>
        </div>
        <StatusPill tone={statusTone(thread.status)} label={thread.statusLabel} />
      </div>
      {thread.why.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {thread.why.map((line) => (
            <li key={line}>• {line}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {thread.nextActions.map((action) =>
          action.href ? (
            <Button key={action.id} asChild size="sm" variant={action.kind === "ops" ? "default" : "outline"}>
              <Link href={action.href}>{action.label}</Link>
            </Button>
          ) : (
            <Button
              key={action.id}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (action.id === "reply" && thread.draftReply) setShowDraft(true);
              }}
            >
              {action.label}
            </Button>
          ),
        )}
        {thread.draftReply ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowDraft((v) => !v)}>
            {showDraft ? "Hide draft" : "Show reply draft"}
          </Button>
        ) : null}
      </div>
      {showDraft && thread.draftReply ? (
        <Textarea className="mt-2 min-h-24 font-mono text-xs" readOnly value={thread.draftReply} />
      ) : null}
    </article>
  );
}

function Section({
  title,
  description,
  threads,
}: {
  title: string;
  description: string;
  threads: ThreadBrief[];
}) {
  if (!threads.length) return null;
  return (
    <Panel title={title} description={description}>
      <div className="space-y-3">
        {threads.map((thread) => (
          <ThreadCard key={thread.id} thread={thread} />
        ))}
      </div>
    </Panel>
  );
}

/**
 * Secretary-style Marketplace inbox brief — what’s going on across scanned chats,
 * who to reply to, and what to do next. Fed by the Chrome helper (or paste later).
 */
export default function MarketplaceBriefPage() {
  const { toast } = useToast();
  const { isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Marketplace brief unlocked",
    successDescription: "Run the Chrome helper Inbox brief, or paste threads when that path lands.",
  });
  const search = useSearch();
  const [brief, setBrief] = useState<InboxBrief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const briefId = useMemo(() => {
    const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
    return params.get("brief")?.trim() || "";
  }, [search]);

  useEffect(() => {
    if (!isUnlocked) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // A historic helper URL may include ?brief=<id>, but the server now
        // keeps one persistent current brief rather than expiring capabilities.
        const response = await fetch("/api/marketplace-brief/latest", { headers });
        const body = (await response.json()) as { ok?: boolean; brief?: InboxBrief; error?: string };
        if (!response.ok || !body.ok || !body.brief) {
          if (response.status === 404) {
            setBrief(null);
            return;
          }
          throw new Error(body.error || "Could not load the current brief");
        }
        setBrief(body.brief);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [briefId, headers, isUnlocked]);

  const demoBrief = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest(
        "POST",
        "/api/marketplace-brief",
        {
          threads: [
            {
              id: "demo-1",
              title: "Alex Rivera (Marketplace)",
              unread: true,
              conversation: `Thread: Alex Rivera
Buyer: Hi, do you still print Acastus Knights?
Buyer: How much shipped to 92101?`,
            },
            {
              id: "demo-2",
              title: "Sam Lee",
              unread: false,
              conversation: `Thread: Sam Lee
Buyer: Looking for Titanicus legs
You: $180 shipped works
You: PayPal when ready
Buyer: Paid $180 via PayPal
Buyer: Need it soon`,
            },
            {
              id: "demo-3",
              title: "Jordan",
              unread: false,
              conversation: `Thread: Jordan
Buyer: Can you do a custom bust?
You: Yes — send references when ready
You: Let me know whenever you're ready`,
            },
          ],
        },
        { headers },
      );
      const body = (await response.json()) as { ok: true; brief: InboxBrief };
      setBrief(body.brief);
      toast({ title: "Demo brief ready", description: body.brief.headline });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Could not build demo brief", description: message.slice(0, 160), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-stack" data-testid="page-marketplace-brief">
      <PageHeader
        title="Marketplace brief"
        subtitle="Secretary view of scanned Marketplace chats — who to reply to, what’s waiting, what to do next."
      />

      {!isUnlocked ? (
        <OwnerUnlockPanel
          title="Unlock Marketplace brief"
          description="Same owner code as Manual / Daily Work."
          buttonLabel="Unlock"
          testIdPrefix="marketplace-brief"
          pending={unlock.isPending}
          onUnlock={(code) => unlock.mutate(code)}
        />
      ) : (
        <>
          <section className="rounded-md border border-card-border bg-card px-4 py-3 text-sm text-muted-foreground">
            <p>
              <strong className="font-medium text-foreground">How to run:</strong> in Chrome, open Messenger /
              Marketplace inbox → extension → <strong className="font-medium text-foreground">Inbox brief</strong>.
              It scans recent threads and opens this page with the secretary summary.
            </p>
            <p className="mt-2">
              Download helper from{" "}
              <a className="hs-link" href="/downloads/messenger-send-to-print-ops-v1.zip" download>
                /downloads/messenger-send-to-print-ops-v1.zip
              </a>
              . Or generate a <button type="button" className="hs-link font-medium" onClick={() => void demoBrief()}>demo brief</button> without Messenger.
            </p>
          </section>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading brief…
            </div>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" data-testid="marketplace-brief-error">
              {error}
            </p>
          ) : null}

          {brief ? (
            <div className="space-y-4">
              <Panel
                title="Today’s secretary note"
                description={new Date(brief.generatedAt).toLocaleString()}
                actions={
                  <Button type="button" size="sm" variant="ghost" onClick={() => void demoBrief()}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Demo again
                  </Button>
                }
              >
                <p className="text-sm text-foreground" data-testid="marketplace-brief-headline">
                  <Sparkles className="mr-1.5 inline h-4 w-4 text-primary" />
                  {brief.headline}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{brief.threadCount} thread(s) reviewed.</p>
              </Panel>

              <Section
                title="Do first"
                description="Your turn, paid needing details, or ready to book."
                threads={brief.doFirst}
              />
              <Section title="Then" description="Payment waiting or stale follow-ups." threads={brief.then} />
              <Section title="Waiting / other" description="Ball in their court, done, or unclear." threads={brief.waiting} />
            </div>
          ) : !loading ? (
            <Panel title="No brief loaded yet" description="Run the Chrome Inbox brief, or try the demo.">
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => void demoBrief()}>
                  <MessageSquareText className="mr-1.5 h-4 w-4" />
                  Build demo brief
                </Button>
                <Button asChild type="button" variant="outline">
                  <a href="/downloads/messenger-send-to-print-ops-v1.zip" download>
                    Download Chrome helper
                  </a>
                </Button>
              </div>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}
