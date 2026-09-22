import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  BarChart3,
  Boxes,
  ClipboardCheck,
  ExternalLink,
  Link2,
  FileUp,
  Lock,
  Moon,
  ListOrdered,
  LayoutDashboard,
  Printer,
  Settings2,
  Ship,
  ShoppingBag,
  Sun,
} from "lucide-react";
import { AttentionBell } from "@/components/attention-bell";
import { OpsAssistantSheet } from "@/components/ops-assistant-sheet";
import { PageTransition } from "@/components/page-transition";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- theme --- */

type Theme = "dark" | "light";

const THEME_KEY = "print-ops-theme-shop";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "dark",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const value = useMemo(
    () => ({ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle({
  className,
  testId = "button-theme-toggle",
  rail = false,
}: {
  className?: string;
  testId?: string;
  rail?: boolean;
}) {
  const { theme, toggle } = useContext(ThemeContext);
  const label = theme === "dark" ? "Light mode" : "Dark mode";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={label}
      data-testid={testId}
      className={cn(
        rail
          ? "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          : "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {theme === "dark" ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
      {rail ? <span className="truncate">{label}</span> : null}
    </button>
  );
}

/* ----------------------------------------------------------------- mark --- */

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Print Operations"
      role="img"
      className={className}
    >
      <rect x="3.5" y="3.5" width="25" height="25" rx="7" stroke="currentColor" strokeWidth="1.8" opacity="0.35" />
      <path d="M9 22h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M11 17h10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.75" />
      <path d="M13 12h6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.5" />
      <circle cx="16" cy="8" r="1.7" fill="currentColor" />
    </svg>
  );
}

/* ---------------------------------------------------------------- shell --- */

/**
 * Shop-floor groups — decluttered so each job has one primary surface.
 * Routes still exist for Clients / Brief / Resin / Focus; they’re just off the rail.
 */
type NavGroup = "Run" | "Take" | "Keep" | "Office";

const NAV: Array<{
  href: string;
  label: string;
  title: string;
  icon: typeof LayoutDashboard;
  testId: string;
  group: NavGroup;
}> = [
  // Run = in-flight work. Queue is the production board; Orders lives under Office.
  { href: "/", label: "Floor", title: "Today’s floor board", icon: LayoutDashboard, testId: "link-nav-home", group: "Run" },
  { href: "/queue", label: "Queue", title: "Production queue", icon: ListOrdered, testId: "link-nav-queue", group: "Run" },
  { href: "/prints", label: "Prints", title: "Plates & print files", icon: FileUp, testId: "link-nav-prints", group: "Run" },
  { href: "/labels", label: "Labels", title: "Shipping labels", icon: Ship, testId: "link-nav-labels", group: "Run" },
  // Take = buyers in. Intake first; Manual for typed entry. Brief/Clients are URL-only.
  { href: "/orders", label: "Intake", title: "Paid Order Intake", icon: Link2, testId: "link-nav-order-links", group: "Take" },
  {
    href: "/paid-orders",
    label: "Manual",
    title: "Manual Order Entry",
    icon: ClipboardCheck,
    testId: "link-nav-paid-orders",
    group: "Take",
  },
  { href: "/printers", label: "Printers", title: "Printer Fleet", icon: Printer, testId: "link-nav-printers", group: "Keep" },
  // Resin inventory stays at /resin (digest / direct URL) but is off the rail —
  // bottle bookkeeping is optional; plate attach + APIs still work without the tab.
  { href: "/supplies", label: "Supplies", title: "Supply Spend", icon: ShoppingBag, testId: "link-nav-supplies", group: "Keep" },
  // Office = numbers + HubSpot stage mirror (not the daily production board).
  { href: "/deals", label: "Orders", title: "HubSpot stage board (mirror)", icon: Boxes, testId: "link-nav-deals", group: "Office" },
  { href: "/operations", label: "Profit", title: "Profit Automation", icon: Activity, testId: "link-nav-operations", group: "Office" },
  { href: "/performance", label: "Stats", title: "Performance", icon: BarChart3, testId: "link-nav-performance", group: "Office" },
  { href: "/setup", label: "Setup", title: "System Setup", icon: Settings2, testId: "link-nav-setup", group: "Office" },
];

const GROUPS: Array<{ id: NavGroup; hint: string }> = [
  { id: "Run", hint: "Today’s jobs" },
  { id: "Take", hint: "Buyers in" },
  { id: "Keep", hint: "Machines & stock" },
  { id: "Office", hint: "Numbers & setup" },
];

/**
 * Workspace shell — shop-floor canvas for Print Ops.
 * Icon rail + top project bar. HubSpot remains CRM of record.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const pathOnly = location.split("?")[0] || "/";
  const { isUnlocked, lock } = useOwnerSession();
  const activeGroup = NAV.find((item) => item.href === pathOnly)?.group ?? "Run";
  const activeItem = NAV.find((item) => item.href === pathOnly);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const runNav = NAV.filter((item) => item.group === "Run");
  const moreNav = NAV.filter((item) => item.group !== "Run");
  const mobileNav = mobileMoreOpen ? NAV : runNav;

  useEffect(() => {
    document.title = activeItem ? `${activeItem.label} · Print Ops` : "Print Ops";
  }, [pathOnly, activeItem]);

  // Soft-refresh HubSpot-backed boards when moving between areas (debounced).
  useEffect(() => {
    if (!isUnlocked) return;
    const timer = window.setTimeout(() => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/performance"],
        refetchType: "active",
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/production-queue"],
        refetchType: "active",
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [pathOnly, isUnlocked]);

  return (
    <div
      className="ops-shell flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground md:flex-row"
      data-nav-group={activeGroup.toLowerCase()}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="link-home-mobile"
          title="Print Ops"
        >
          <span className="ops-mark-wrap inline-flex h-7 w-7 items-center justify-center rounded-full">
            <Mark className="h-5 w-5 shrink-0 text-primary-foreground" />
          </span>
          <span className="truncate text-sm font-medium">Print Ops</span>
        </Link>
        <span className="status-live" data-testid="status-workspace-live-mobile">
          Online
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <OpsAssistantSheet />
          <AttentionBell />
          <ThemeToggle />
          {isUnlocked ? (
            <button
              type="button"
              onClick={lock}
              title="Lock owner session"
              data-testid="button-lock-owner-session-mobile"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Lock className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      <aside className="ops-rail hidden min-h-0 w-[15rem] shrink-0 flex-col overflow-x-hidden border-r border-sidebar-border bg-sidebar px-2 py-3 text-sidebar-foreground md:flex">
        <Link
          href="/"
          className="mb-3 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          data-testid="link-home"
          title="Print Ops"
        >
          <span className="ops-mark-wrap inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full">
            <Mark className="h-5 w-5 text-primary-foreground" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-sidebar-accent-foreground">Print Ops</span>
          </span>
          <span className="status-live ml-auto" data-testid="status-workspace-live">
            Online
          </span>
        </Link>

        <nav
          aria-label="Primary navigation"
          className="flex w-full min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {GROUPS.map((group) => (
            <div key={group.id} className="flex w-full flex-col gap-0.5">
              <p
                className="mb-0.5 truncate px-2.5 text-left text-[0.6875rem] font-medium text-sidebar-foreground/45"
                title={group.hint}
              >
                {group.id}
              </p>
              {NAV.filter((item) => item.group === group.id).map((item) => {
                const active = pathOnly === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={item.title}
                    data-testid={item.testId}
                    data-active={active ? "true" : "false"}
                    className={cn(
                      "ops-rail-link flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-[background-color,color] duration-150 ease-out",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "font-normal text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-0.5 border-t border-sidebar-border pt-2">
          <OpsAssistantSheet rail />
          <AttentionBell rail />
          <ThemeToggle rail />
          {isUnlocked ? (
            <button
              type="button"
              onClick={lock}
              title="Lock owner session"
              data-testid="button-lock-owner-session"
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Lock className="h-4 w-4 shrink-0" />
              Lock
            </button>
          ) : null}
          <a
            href="https://app.hubspot.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="HubSpot CRM"
            data-testid="link-sidebar-hubspot"
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <ExternalLink className="h-4 w-4 shrink-0" />
            <span className="truncate">HubSpot</span>
          </a>
        </div>
      </aside>

      <div className="ops-stage relative flex min-h-0 min-w-0 flex-1 flex-col">
        <nav
          aria-label="Mobile navigation"
          className="relative z-[1] flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5 md:hidden"
        >
          {mobileNav.map((item) => {
            const active = pathOnly === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.title}
                data-testid={item.testId}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-medium transition-[background-color,color] duration-150 ease-out",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-card/70 text-muted-foreground hover:text-foreground",
                )}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMobileMoreOpen((open) => !open)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-medium",
              mobileMoreOpen || moreNav.some((item) => item.href === pathOnly)
                ? "bg-muted text-foreground"
                : "bg-card/70 text-muted-foreground hover:text-foreground",
            )}
            data-testid="button-mobile-nav-more"
            aria-expanded={mobileMoreOpen}
          >
            {mobileMoreOpen ? "Less" : "More"}
          </button>
        </nav>

        <main
          className="scroll-pane relative z-[1] min-h-0 min-w-0 flex-1 bg-transparent"
          data-scroll-pane
        >
          <PageTransition routeKey={pathOnly}>{children}</PageTransition>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  /** Kept so existing pages can pass a group label. The title stands alone. */
  eyebrow?: string;
}) {
  return (
    <header className="ops-page-header px-4 pb-2 pt-6 md:px-8 md:pt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1
            className="truncate text-[1.65rem] font-semibold tracking-tight text-foreground md:text-[1.85rem] md:leading-tight"
            data-testid="text-page-title"
          >
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
    </header>
  );
}
