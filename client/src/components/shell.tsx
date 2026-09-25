import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  BarChart3,
  Boxes,
  ClipboardCheck,
  ExternalLink,
  FileUp,
  LayoutDashboard,
  Link2,
  ListChecks,
  ListOrdered,
  Lock,
  Menu,
  Moon,
  Printer,
  RefreshCw,
  Settings2,
  Ship,
  ShoppingBag,
  Sun,
} from "lucide-react";
import { AttentionBell } from "@/components/attention-bell";
import { HubspotSyncDialog } from "@/components/hubspot-sync-chip";
import { OpsAssistantSheet } from "@/components/ops-assistant-sheet";
import { PageTransition } from "@/components/page-transition";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { useShopCounts } from "@/hooks/use-shop-counts";
import { queryClient } from "@/lib/queryClient";
import { formatPacificSnapshot, syncPillCopy } from "@/lib/sync-status";
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
          ? "ops-rail-link"
          : "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

type NavGroup = "Run" | "Take" | "Keep" | "Office";

const NAV: Array<{
  href: string;
  label: string;
  title: string;
  icon: typeof LayoutDashboard;
  testId: string;
  group: NavGroup;
  phone?: "tab" | "more" | "never";
}> = [
  { href: "/", label: "Floor", title: "Today’s floor board", icon: LayoutDashboard, testId: "link-nav-home", group: "Run", phone: "tab" },
  { href: "/stack", label: "Stack", title: "This week's priority stack", icon: ListChecks, testId: "link-nav-stack", group: "Run", phone: "tab" },
  { href: "/queue", label: "Queue", title: "Production queue", icon: ListOrdered, testId: "link-nav-queue", group: "Run", phone: "tab" },
  { href: "/prints", label: "Prints", title: "Plates & print files", icon: FileUp, testId: "link-nav-prints", group: "Run", phone: "tab" },
  { href: "/labels", label: "Labels", title: "Shipping labels", icon: Ship, testId: "link-nav-labels", group: "Run", phone: "more" },
  { href: "/orders", label: "Intake", title: "Paid Order Intake", icon: Link2, testId: "link-nav-order-links", group: "Take", phone: "more" },
  {
    href: "/paid-orders",
    label: "Manual",
    title: "Manual Order Entry",
    icon: ClipboardCheck,
    testId: "link-nav-paid-orders",
    group: "Take",
    phone: "more",
  },
  { href: "/printers", label: "Printers", title: "Printer Fleet", icon: Printer, testId: "link-nav-printers", group: "Keep", phone: "more" },
  { href: "/supplies", label: "Supplies", title: "Supply Spend", icon: ShoppingBag, testId: "link-nav-supplies", group: "Keep", phone: "more" },
  { href: "/deals", label: "Orders", title: "HubSpot stage board (mirror)", icon: Boxes, testId: "link-nav-deals", group: "Office", phone: "never" },
  { href: "/operations", label: "Profit", title: "Profit Automation", icon: Activity, testId: "link-nav-operations", group: "Office", phone: "more" },
  { href: "/performance", label: "Stats", title: "Performance", icon: BarChart3, testId: "link-nav-performance", group: "Office", phone: "more" },
  { href: "/setup", label: "Setup", title: "System Setup", icon: Settings2, testId: "link-nav-setup", group: "Office", phone: "more" },
];

const GROUPS: Array<{ id: NavGroup; hint: string }> = [
  { id: "Run", hint: "Today’s jobs" },
  { id: "Take", hint: "Buyers in" },
  { id: "Keep", hint: "Machines & stock" },
  { id: "Office", hint: "Numbers & setup" },
];

const PHONE_TABS = NAV.filter((item) => item.phone === "tab");
const PHONE_MORE = NAV.filter((item) => item.phone === "more");

function refreshShop() {
  void queryClient.invalidateQueries({ queryKey: ["/api/health"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/priority-stack"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/printers"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/resin-reorder"] });
}

function SyncPill() {
  const { health } = useShopCounts();
  const copy = syncPillCopy(health?.hubspotSync);
  const pill = (
    <span className={cn("sync-pill", copy.tone === "warn" && "sync-pill-warn")} data-testid="status-hubspot-sync-pill">
      <span className="sync-pill-dot" aria-hidden />
      <span className="truncate">{copy.label}</span>
    </span>
  );
  if (copy.tone === "warn") {
    return (
      <HubspotSyncDialog
        trigger={
          <button type="button" className="max-w-full" data-testid="button-hubspot-sync-pill">
            {pill}
          </button>
        }
      />
    );
  }
  return pill;
}

function RefreshButton({ testId }: { testId: string }) {
  return (
    <button
      type="button"
      onClick={refreshShop}
      title="Refresh"
      aria-label="Refresh"
      data-testid={testId}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <RefreshCw className="h-4 w-4" />
    </button>
  );
}

function NavCount({ value, hot, testId }: { value: number | null; hot?: boolean; testId?: string }) {
  if (value == null) return null;
  const emphasize = Boolean(hot && value > 0);
  return (
    <span className={cn("nav-count numeric", emphasize && "nav-count-hot")} data-testid={testId}>
      {value}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const pathOnly = location.split("?")[0] || "/";
  const { isUnlocked, lock } = useOwnerSession();
  const shop = useShopCounts();
  const activeItem = NAV.find((item) => item.href === pathOnly);
  const activeGroup = activeItem?.group ?? "Run";
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = PHONE_MORE.some((item) => item.href === pathOnly);

  useEffect(() => {
    document.title = activeItem ? `${activeItem.label} · Print Ops` : "Print Ops";
  }, [pathOnly, activeItem]);

  useEffect(() => {
    setMoreOpen(false);
  }, [pathOnly]);

  useEffect(() => {
    if (!isUnlocked) return;
    const timer = window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["/api/performance"], refetchType: "active" });
      void queryClient.invalidateQueries({ queryKey: ["/api/production-queue"], refetchType: "active" });
      void queryClient.invalidateQueries({ queryKey: ["/api/priority-stack"], refetchType: "active" });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [pathOnly, isUnlocked]);

  const countFor = (href: string): { value: number | null; hot?: boolean; testId?: string } | null => {
    if (href === "/") return { value: shop.needsYou, hot: true, testId: "badge-nav-floor" };
    if (href === "/stack") return { value: shop.stackCount, testId: "badge-nav-stack" };
    if (href === "/queue") return { value: shop.queueCount, testId: "badge-nav-queue" };
    return null;
  };

  return (
    <div className="ops-shell flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground md:flex-row" data-nav-group={activeGroup.toLowerCase()}>
      <aside className="ops-rail hidden md:flex">
        <Link href="/" className="ops-brand" data-testid="link-home" title="Print Ops">
          <span className="ops-mark-wrap">
            <Mark className="h-4 w-4 text-primary-foreground" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold tracking-tight text-foreground">Print Ops</span>
            <span className="block truncate text-[11px] text-[hsl(var(--text-3))]">Resin print shop</span>
          </span>
        </Link>

        <nav aria-label="Primary navigation" className="ops-rail-nav">
          {GROUPS.map((group) => (
            <div key={group.id} className="flex w-full flex-col gap-0.5">
              <p className="ops-rail-label" title={group.hint}>
                {group.id}
              </p>
              {NAV.filter((item) => item.group === group.id).map((item) => {
                const active = pathOnly === item.href;
                const count = countFor(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={item.title}
                    data-testid={item.testId}
                    data-active={active ? "true" : "false"}
                    className="ops-rail-link"
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {count ? <NavCount {...count} /> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="ops-rail-foot">
          <OpsAssistantSheet rail />
          <ThemeToggle rail />
          <a
            href="https://app.hubspot.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="HubSpot CRM"
            data-testid="link-sidebar-hubspot"
            className="ops-rail-link"
          >
            <ExternalLink className="h-4 w-4 shrink-0" />
            <span className="truncate">HubSpot</span>
          </a>
          <div className="ops-owner">
            <span className="ops-avatar" aria-hidden>
              O
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-foreground">Owner</span>
              <span className="block truncate text-[11px] text-[hsl(var(--text-3))]">{isUnlocked ? "Unlocked" : "Locked"}</span>
            </span>
            {isUnlocked ? (
              <button
                type="button"
                onClick={lock}
                title="Lock owner session"
                data-testid="button-lock-owner-session"
                className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[hsl(var(--hover))] hover:text-foreground"
              >
                <Lock className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="ops-stage relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="ops-topbar hidden md:flex">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-foreground">{activeItem?.label ?? "Print Ops"}</p>
            {shop.pulledAt ? (
              <p className="truncate text-[12px] text-[hsl(var(--text-3))]" data-testid="text-snapshot-time">
                {formatPacificSnapshot(shop.pulledAt)}
              </p>
            ) : null}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <SyncPill />
            <AttentionBell />
            <RefreshButton testId="button-refresh-workspace" />
          </div>
        </header>

        <header className="ops-phone-bar flex md:hidden">
          <Link href="/" className="flex min-w-0 items-center gap-2" data-testid="link-home-mobile" title="Print Ops">
            <span className="ops-mark-wrap h-[26px] w-[26px] rounded-[7px]">
              <Mark className="h-3.5 w-3.5 text-primary-foreground" />
            </span>
            <span className="truncate text-[17px] font-semibold tracking-tight">{activeItem?.label ?? "Print Ops"}</span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <RefreshButton testId="button-refresh-workspace-mobile" />
            <AttentionBell />
            {isUnlocked ? (
              <button
                type="button"
                onClick={lock}
                title="Lock owner session"
                data-testid="button-lock-owner-session-mobile"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground"
              >
                <Lock className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </header>

        <main className="scroll-pane relative z-[1] min-h-0 min-w-0 flex-1 bg-transparent pb-24 md:pb-0" data-scroll-pane>
          <PageTransition routeKey={pathOnly}>{children}</PageTransition>
        </main>

        {moreOpen ? (
          <div className="ops-more-sheet flex md:hidden" data-testid="panel-mobile-more">
            <p className="ops-rail-label px-1">More</p>
            {PHONE_MORE.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`link-phone-${item.label.toLowerCase()}`}
                className={cn("ops-rail-link", pathOnly === item.href && "bg-[hsl(var(--raised))] font-semibold text-foreground")}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </Link>
            ))}
            <OpsAssistantSheet rail />
            <ThemeToggle rail />
          </div>
        ) : null}

        <nav aria-label="Mobile navigation" className="ops-tabbar grid md:hidden">
          {PHONE_TABS.map((item) => {
            const active = pathOnly === item.href;
            const count = item.href === "/" ? shop.needsYou : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`link-phone-${item.label.toLowerCase()}`}
                data-active={active ? "true" : "false"}
                className="ops-tab"
              >
                <span className="relative">
                  <item.icon className="h-5 w-5" />
                  {count != null && count > 0 ? (
                    <span className="ops-tab-badge numeric" data-testid="badge-phone-floor">
                      {count > 9 ? "9+" : count}
                    </span>
                  ) : null}
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            className="ops-tab"
            data-active={moreOpen || moreActive ? "true" : "false"}
            data-testid="button-mobile-nav-more"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <Menu className="h-5 w-5" />
            <span>More</span>
          </button>
        </nav>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  hideActionsOnPhone = false,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  eyebrow?: string;
  hideActionsOnPhone?: boolean;
}) {
  return (
    <header className={cn("ops-page-header px-4 pb-2 pt-4 md:px-8 md:pt-8", (hideActionsOnPhone || !actions) && "max-md:hidden")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-md:hidden">
          <h1 className="ops-page-title" data-testid="text-page-title">
            {title}
          </h1>
          {subtitle ? <p className="mt-1 max-w-3xl text-sm leading-5 text-[hsl(var(--text-2))]">{subtitle}</p> : null}
        </div>
        {actions ? (
          <div className={cn("flex flex-wrap items-center gap-1.5", hideActionsOnPhone && "max-md:hidden")}>{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
