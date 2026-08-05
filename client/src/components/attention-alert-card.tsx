import { Link } from "wouter";
import { AlertTriangle, ClipboardList, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/primitives";
import { attentionNextStep } from "@/lib/workflow";
import { cn } from "@/lib/utils";

const ISSUE_SURFACE = {
  neutral: "border-border bg-muted/45",
  warn: "border-primary/35 bg-primary/5",
  bad: "border-destructive/35 bg-destructive/5",
} as const;

export type AttentionAlertItem = {
  dealId: string;
  dealName: string;
  stage: string;
  issue: string;
  issueKey: string;
  detail: string;
  severity: "neutral" | "warn" | "bad";
};

/**
 * Stable attention row: title + Skip on one line, issue pill on its own row,
 * then detail and action. Avoids flex-wrap shoving the pill right/left when
 * deal names vary in length.
 */
export function AttentionAlertCard({
  item,
  portalId,
  dense = false,
  dismissPending = false,
  onDismiss,
  testId,
}: {
  item: AttentionAlertItem;
  portalId?: string | null;
  dense?: boolean;
  dismissPending?: boolean;
  onDismiss: () => void;
  testId?: string;
}) {
  const next = attentionNextStep({ ...item, portalId });
  const pad = dense ? "p-2.5" : "p-3";

  return (
    <article
      className={cn("rounded-md border", pad, ISSUE_SURFACE[item.severity])}
      data-testid={testId}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium leading-5">{item.dealName}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{item.stage}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
          disabled={dismissPending}
          onClick={onDismiss}
          title="Skip this alert for this order"
          data-testid={`button-dismiss-attention-${item.dealId}-${item.issueKey}`}
        >
          <X className="mr-1 h-3 w-3" />
          Skip
        </Button>
      </div>

      <div className="mt-2">
        <StatusPill
          tone={item.severity}
          icon={item.severity === "bad" ? AlertTriangle : ClipboardList}
          label={item.issue}
          testId={`pill-attention-${item.dealId}-${item.issueKey}`}
        />
      </div>

      <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>

      <div className="mt-2">
        {next.external ? (
          <a
            href={next.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            data-testid={`link-attention-action-${item.dealId}`}
          >
            {next.label}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <Link
            href={next.href}
            className="text-xs font-medium text-primary hover:underline"
            data-testid={`link-attention-action-${item.dealId}`}
          >
            {next.label}
          </Link>
        )}
      </div>
    </article>
  );
}
