import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  BarChart3,
  Beaker,
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
  ShoppingBag,
  Settings2,
  ShipWheel,
  Sun,
} from "lucide-react";
import { AttentionBell } from "@/components/attention-bell";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- theme --- */

type Theme = "dark" | "light";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "light",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("print-ops-theme");
    if (saved === "light" || saved === "dark") return saved;
    return "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    window.localStorage.setItem("print-ops-theme", theme);
  }, [theme]);

  const value = useMemo(
    () => ({ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle({ className, testId = "button-theme-toggle" }: { className?: string; testId?: string }) {
  const { theme, toggle } = useContext(ThemeContext);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      data-testid={testId}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

/* ----------------------------------------------------------------- mark --- */

/**
 * Layered-print mark: three stacked strokes narrowing upward with a resin dot
 * on top — a print bed building a part, reduced to four elements.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Print Operations"
      role="img"
      className={className}
    >
      <path
        d="M6 24.5h20"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity="0.35"
      />
      <path d="M9 19h14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path
        d="M13 13.5h6"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity="0.7"
      />
      <circle cx="16" cy="7.5" r="2.2" fill="currentColor" />
    </svg>
  );
}

/* ---------------------------------------------------------------- shell --- */

const NAV = [
  { href: "/", label: "Floor", title: "Shop floor", icon: LayoutDashboard, testId: "link-nav-home", group: "Floor" },
  { href: "/queue", label: "Queue", title: "Production queue", icon: ListOrdered, testId: "link-nav-queue", group: "Floor" },
  { href: "/deals", label: "Orders", title: "Print Orders board", icon: Boxes, testId: "link-nav-deals", group: "Floor" },
  { href: "/prints", label: "Prints", title: "Prints", icon: FileUp, testId: "link-nav-prints", group: "Floor" },
  { href: "/printers", label: "Printers", title: "Printer Fleet", icon: Printer, testId: "link-nav-printers", group: "Floor" },
  { href: "/orders", label: "Intake", title: "Paid Order Intake", icon: Link2, testId: "link-nav-order-links", group: "Bench" },
  {
    href: "/paid-orders",
    label: "Manual",
    title: "Manual Order Entry",
    icon: ClipboardCheck,
    testId: "link-nav-paid-orders",
    group: "Bench",
  },
  { href: "/supplies", label: "Supplies", title: "Supply Spend", icon: ShoppingBag, testId: "link-nav-supplies", group: "Bench" },
  { href: "/resin", label: "Resin", title: "Resin Inventory", icon: Beaker, testId: "link-nav-resin", group: "Bench" },
  { href: "/operations", label: "Profit", title: "Profit Automation", icon: Activity, testId: "link-nav-operations", group: "System" },
  { href: "/performance", label: "Stats", title: "Performance", icon: BarChart3, testId: "link-nav-performance", group: "System" },
  { href: "/setup", label: "Setup", title: "System Setup", icon: Settings2, testId: "link-nav-setup", group: "System" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const groups = Array.from(new Set(NAV.map((item) => item.group)));
  const { isUnlocked, lock } = useOwnerSession();

  useEffect(() => {
    document.title = "Print Ops";
  }, [location]);

  return (
    <div className="grid h-[100dvh] grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground md:grid-cols-[11.5rem_1fr] md:grid-rows-1">
      <aside className="flex min-w-0 shrink-0 items-center gap-3 border-b border-sidebar-border bg-sidebar px-3 py-3 text-sidebar-foreground md:h-full md:flex-col md:items-stretch md:gap-4 md:border-b-0 md:border-r md:px-2.5 md:py-5">
        <div className="flex min-w-0 items-center gap-2 md:flex-col md:items-stretch md:gap-3">
          <Link
            href="/"
            className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring md:flex-col md:gap-2 md:px-1 md:pt-0.5"
            data-testid="link-home"
            title="Print Ops"
          >
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/15 text-sidebar-primary ring-1 ring-sidebar-primary/25 transition-transform duration-200 group-hover:scale-[1.03]">
              <Mark className="h-5 w-5" />
            </span>
            <span className="min-w-0 truncate md:text-center">
              <span className="block text-sm font-semibold tracking-tight text-sidebar-foreground">Print Ops</span>
              <span className="hidden text-[0.65rem] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/45 md:block">
                Shop floor
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-1.5 md:justify-center">
            <AttentionBell />
            <ThemeToggle className="md:hidden" testId="button-theme-toggle-mobile" />
          </div>
        </div>

        <nav
          aria-label="Primary navigation"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:block md:overflow-visible md:overflow-y-auto"
        >
          {groups.map((group) => (
            <div key={group} className="flex shrink-0 items-center gap-1 md:mb-4 md:block">
              <p className="hidden px-2.5 pb-1.5 pt-0.5 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/40 md:block">
                {group}
              </p>
              {NAV.filter((item) => item.group === group).map((item) => {
                const active = location === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={item.title}
                    data-testid={item.testId}
                    className={cn(
                      "relative flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-all duration-150 md:mb-0.5 md:w-full md:gap-2.5 md:px-2.5 md:py-2",
                      active
                        ? "bg-sidebar-primary/15 font-semibold text-sidebar-foreground shadow-[inset_3px_0_0_0_hsl(var(--sidebar-primary))]"
                        : "nav-ink",
                    )}
                  >
                    <item.icon className={cn("h-4 w-4 shrink-0", active ? "text-sidebar-primary" : "opacity-80")} />
                    <span className="text-[0.8125rem] font-medium tracking-tight">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto hidden space-y-0.5 border-t border-sidebar-border pt-3 md:block">
          <p className="px-2.5 pb-1.5 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/40">
            Tools
          </p>
          <a
            href="https://app.hubspot.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="HubSpot CRM"
            data-testid="link-sidebar-hubspot"
            className="nav-ink flex items-center gap-2.5 rounded-lg px-2.5 py-2"
          >
            <ExternalLink className="h-3.5 w-3.5 opacity-80" />
            <span className="text-[0.8125rem] font-medium">HubSpot</span>
          </a>
          <a
            href="https://ship.pirateship.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="Pirate Ship"
            data-testid="link-sidebar-pirateship"
            className="nav-ink flex items-center gap-2.5 rounded-lg px-2.5 py-2"
          >
            <ShipWheel className="h-3.5 w-3.5 opacity-80" />
            <span className="text-[0.8125rem] font-medium">Ship</span>
          </a>
          <ThemeToolButton />
          {isUnlocked ? (
            <button
              type="button"
              onClick={lock}
              title="Lock owner session"
              data-testid="button-lock-owner-session"
              className="nav-ink flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2"
            >
              <Lock className="h-3.5 w-3.5 opacity-80" />
              <span className="text-[0.8125rem] font-medium">Lock</span>
            </button>
          ) : null}
        </div>
      </aside>

      <main className="scroll-pane min-h-0 min-w-0 bg-transparent">{children}</main>
    </div>
  );
}

function ThemeToolButton() {
  const { theme, toggle } = useContext(ThemeContext);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      data-testid="button-theme-toggle"
      className="nav-ink flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2"
    >
      {theme === "dark" ? <Sun className="h-3.5 w-3.5 opacity-80" /> : <Moon className="h-3.5 w-3.5 opacity-80" />}
      <span className="text-[0.8125rem] font-medium">Theme</span>
    </button>
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
}) {
  return (
    <header className="accent-wash sticky top-0 z-10 border-b border-border/80 px-4 py-3.5 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 surface-rise">
          <h1
            className="truncate text-[1.35rem] font-semibold tracking-tight text-foreground md:text-2xl"
            data-testid="text-page-title"
          >
            {title}
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{subtitle}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
