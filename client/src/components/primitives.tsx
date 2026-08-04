import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "good" | "warn" | "bad";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  good: "text-chart-4",
  warn: "text-primary",
  bad: "text-destructive",
};

const TONE_PILL: Record<Tone, string> = {
  neutral: "border-border bg-muted/50 text-muted-foreground",
  good: "border-chart-4/40 bg-chart-4/10 text-chart-4",
  warn: "border-primary/45 bg-primary/10 text-primary",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function StatusPill({
  tone,
  icon: Icon,
  label,
  testId,
}: {
  tone: Tone;
  icon: LucideIcon;
  label: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide",
        TONE_PILL[tone],
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  tone?: Tone;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-card-border bg-card p-3.5 transition-colors hover:border-border"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="rule-label">{label}</p>
        <Icon className={cn("h-3.5 w-3.5", TONE_TEXT[tone])} />
      </div>
      <p className={cn("mt-1.5 text-base font-semibold tracking-tight", TONE_TEXT[tone])}>{value}</p>
      <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function CodeLine({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <code
      data-testid={testId}
      className="numeric rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[0.6875rem]"
    >
      {children}
    </code>
  );
}
