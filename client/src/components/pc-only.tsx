import type { ReactNode } from "react";
import { Link } from "wouter";
import { Monitor } from "lucide-react";
import { useIsPhone } from "@/hooks/use-is-phone";
import { cn } from "@/lib/utils";

/** Renders children everywhere except phones. */
export function PcOnly({ children }: { children: ReactNode }) {
  const isPhone = useIsPhone();
  return isPhone ? null : <>{children}</>;
}

/** Short "Do this on your PC" note for phones (charcoal + amber, 44px tap target). */
export function PcOnlyNote({
  what,
  detail,
  alt,
  className,
  testId = "note-pc-only",
}: {
  what: string;
  detail?: string;
  alt?: { href: string; label: string };
  className?: string;
  testId?: string;
}) {
  return (
    <section
      className={cn("mx-4 mt-4 rounded-lg border border-border bg-card p-4", className)}
      data-testid={testId}
      aria-label="Do this on your PC"
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--amber)/0.15)] text-[hsl(var(--amber))]">
          <Monitor className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Do this on your PC</p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {what}
            {detail ? ` ${detail}` : " is a PC job, so it is hidden on the phone."}
          </p>
          {alt ? (
            <Link
              href={alt.href}
              className="mt-3 inline-flex min-h-[44px] items-center rounded-md border border-border px-3 text-sm font-medium text-[hsl(var(--amber))]"
              data-testid={`${testId}-alt`}
            >
              {alt.label}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
