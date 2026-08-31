import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "good" | "warn" | "bad";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  good: "text-accent",
  warn: "text-chart-4",
  bad: "text-destructive",
};

const TONE_PILL: Record<Tone, string> = {
  neutral: "border-border bg-muted/45 text-muted-foreground",
  good: "border-accent/40 bg-accent/12 text-accent",
  warn: "border-chart-4/40 bg-chart-4/12 text-chart-4",
  bad: "border-destructive/40 bg-destructive/12 text-destructive",
};

export function StatusPill({
  tone,
  icon: Icon,
  label,
  testId,
}: {
  tone: Tone;
  icon?: LucideIcon;
  label: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-wide",
        TONE_PILL[tone],
      )}
    >
      {Icon ? <Icon className="h-2.5 w-2.5 shrink-0" /> : null}
      <span className="min-w-0 truncate">{label}</span>
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
    <div data-testid={testId} className="metric-tile">
      <div className="flex items-center justify-between gap-2">
        <p className="rule-label">{label}</p>
        <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted/80", TONE_TEXT[tone])}>
          <Icon className="h-3.5 w-3.5" />
        </span>
      </div>
      <p className={cn("mt-1.5 text-lg font-semibold tracking-tight numeric", tone === "neutral" ? "text-foreground" : TONE_TEXT[tone])}>
        {value}
      </p>
      <p className="mt-0.5 line-clamp-2 break-words text-[0.6875rem] leading-4 text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Primary workspace container — titled group for related shop data.
 * Use for Floor sections, Queue lanes, and board columns.
 */
export function WorkspaceSection({
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
  testId,
  dense = false,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
  dense?: boolean;
}) {
  return (
    <section className={cn("workspace-section", className)} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/80 px-3.5 py-2.5">
        <div className="min-w-0">
          {eyebrow ? <p className="rule-label mb-0.5">{eyebrow}</p> : null}
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      <div className={cn(dense ? "p-2.5" : "p-3.5")}>{children}</div>
    </section>
  );
}

/** Back-compat alias — existing pages import Panel. */
export function Panel({
  title,
  description,
  actions,
  children,
  testId,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <WorkspaceSection title={title} description={description} actions={actions} testId={testId} className={className}>
      {children}
    </WorkspaceSection>
  );
}

/** Grouped list of related rows (active orders, failures, etc.). */
export function DataList({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <ul className={cn("data-list", className)} data-testid={testId}>
      {children}
    </ul>
  );
}

export function DataRow({
  title,
  meta,
  actions,
  tone,
  badge,
  testId,
}: {
  title: string;
  meta?: string;
  actions?: ReactNode;
  tone?: Tone;
  badge?: string;
  testId?: string;
}) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2.5"
      data-testid={testId}
      data-tone={tone}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{title}</p>
          {badge ? <StatusPill tone={tone ?? "neutral"} label={badge} /> : null}
        </div>
        {meta ? <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{meta}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2.5 text-xs">{actions}</div> : null}
    </li>
  );
}

export function CodeLine({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <code
      data-testid={testId}
      className="numeric rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[0.6875rem]"
    >
      {children}
    </code>
  );
}
