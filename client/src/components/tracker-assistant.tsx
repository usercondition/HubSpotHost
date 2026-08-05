import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { ExternalLink, Loader2, MessageSquareText, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import type { TrackerAssistantResponse } from "@shared/schema";

const SUGGESTIONS = [
  "What should I do next?",
  "Which deals need plates?",
  "What’s stuck or missing costs?",
  "Draft a Marketplace reminder",
  "How are margins looking?",
];

export function TrackerAssistantPanel({ headers }: { headers: Record<string, string> }) {
  const [question, setQuestion] = useState("What should I do next?");
  const [answer, setAnswer] = useState<TrackerAssistantResponse | null>(null);
  const [digestNote, setDigestNote] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: async (nextQuestion: string) => {
      const response = await apiRequest(
        "POST",
        "/api/tracker-assistant",
        { question: nextQuestion },
        { headers },
      );
      return (await response.json()) as TrackerAssistantResponse;
    },
    onSuccess: (data) => setAnswer(data),
  });

  const sendDigest = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/owner-digest/send", {}, { headers });
      return (await response.json()) as { ok: boolean; messageId?: number; error?: string };
    },
    onSuccess: (data) => {
      setDigestNote(
        data.ok
          ? `Sent to Telegram${data.messageId ? ` (#${data.messageId})` : ""}.`
          : data.error || "Could not send Telegram digest.",
      );
    },
    onError: (error) => {
      setDigestNote((error as Error).message.replace(/^\d+:\s*/, "").slice(0, 200) || "Could not send Telegram digest.");
    },
  });

  const runAsk = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned || ask.isPending) return;
    setQuestion(cleaned);
    ask.mutate(cleaned);
  };

  return (
    <section
      className="rounded-lg border border-card-border bg-card"
      aria-labelledby="tracker-assistant-title"
      data-testid="panel-tracker-assistant"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <p className="rule-label">Ask the tracker</p>
          <h2 id="tracker-assistant-title" className="mt-1 flex items-center gap-2 text-base font-semibold tracking-tight">
            <Sparkles className="h-4 w-4 text-primary" />
            Ops briefing from live queue data
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Read-only helper — prioritizes intake, plates, costs, and stale deals. Never writes to HubSpot.
          </p>
        </div>
        {answer ? (
          <span className="rule-label" data-testid="text-tracker-assistant-mode">
            {answer.mode === "model" ? "Model + tracker" : "Tracker rules"}
          </span>
        ) : null}
      </div>

      <div className="space-y-4 p-5">
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="rounded-md border border-border bg-muted/35 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/70"
              onClick={() => runAsk(suggestion)}
              data-testid={`button-tracker-suggestion-${suggestion.slice(0, 12).replace(/\s+/g, "-").toLowerCase()}`}
            >
              {suggestion}
            </button>
          ))}
        </div>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            runAsk(question);
          }}
        >
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            className="min-h-20 resize-y text-sm"
            placeholder="Ask what needs attention today…"
            data-testid="input-tracker-assistant-question"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={ask.isPending || question.trim().length === 0} data-testid="button-tracker-assistant-ask">
              {ask.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageSquareText className="mr-2 h-4 w-4" />}
              Ask tracker
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={sendDigest.isPending}
              onClick={() => {
                setDigestNote(null);
                sendDigest.mutate();
              }}
              data-testid="button-owner-digest-send"
            >
              {sendDigest.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send to Telegram
            </Button>
          </div>
        </form>

        {digestNote ? (
          <p className="text-sm text-muted-foreground" data-testid="text-owner-digest-note">
            {digestNote}
          </p>
        ) : null}

        {ask.isError ? (
          <p className="text-sm text-destructive" data-testid="text-tracker-assistant-error">
            {(ask.error as Error).message.replace(/^\d+:\s*/, "").slice(0, 200) || "Could not ask the tracker."}
          </p>
        ) : null}

        {answer ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/25 p-4" data-testid="panel-tracker-assistant-answer">
            <p className="whitespace-pre-wrap text-sm leading-6" data-testid="text-tracker-assistant-reply">
              {answer.reply}
            </p>
            {answer.actions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {answer.actions.map((action) =>
                  action.external ? (
                    <Button key={`${action.href}-${action.label}`} asChild size="sm" variant="outline">
                      <a href={action.href} target="_blank" rel="noopener noreferrer">
                        {action.label}
                        <ExternalLink className="ml-1.5 h-3 w-3" />
                      </a>
                    </Button>
                  ) : (
                    <Button key={`${action.href}-${action.label}`} asChild size="sm" variant="outline">
                      <Link href={action.href}>{action.label}</Link>
                    </Button>
                  ),
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
