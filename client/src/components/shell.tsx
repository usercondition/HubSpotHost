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
        "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-sidebar-foreground/80 transition-colors hover:bg-white/10 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        className,
      )}
    >
      {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
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

type NavGroup = "Sell" | "Make" | "Stock" | "System";

const NAV: Array<{
  href: string;
  label: string;
  title: string;
  icon: typeof LayoutDashboard;
  testId: string;
  group: NavGroup;
}> = [
  { href: "/", label: "Home", title: "Overview", icon: LayoutDashboard, testId: "link-nav-home", group: "Sell" },
  { href: "/orders", label: "Intake", title: "Paid Order Intake", icon: Link2, testId: "link-nav-order-links", group: "Sell" },
  {
    href: "/paid-orders",
    label: "Manual",
    title: "Manual Order Entry",
    icon: ClipboardCheck,
    testId: "link-nav-paid-orders",
    group: "Sell",
  },
  { href: "/queue", label: "Queue", title: "Production queue", icon: ListOrdered, testId: "link-nav-queue", group: "Make" },
  { href: "/deals", label: "Orders", title: "Print Orders board", icon: Boxes, testId: "link-nav-deals", group: "Make" },
  { href: "/prints", label: "Prints", title: "Prints", icon: FileUp, testId: "link-nav-prints", group: "Make" },
  { href: "/printers", label: "Printers", title: "Printer Fleet", icon: Printer, testId: "link-nav-printers", group: "Make" },
  { href: "/resin", label: "Resin", title: "Resin Inventory", icon: Beaker, testId: "link-nav-resin", group: "Stock" },
  { href: "/supplies", label: "Supplies", title: "Supply Spend", icon: ShoppingBag, testId: "link-nav-supplies", group: "Stock" },
  { href: "/operations", label: "Profit", title: "Profit Automation", icon: Activity, testId: "link-nav-operations", group: "System" },
  { href: "/performance", label: "Stats", title: "Performance", icon: BarChart3, testId: "link-nav-performance", group: "System" },
  { href: "/setup", label: "Setup", title: "System Setup", icon: Settings2, testId: "link-nav-setup", group: "System" },
];

const GROUPS: NavGroup[] = ["Sell", "Make", "Stock", "System"];

const GROUP_HOME: Record<NavGroup, string> = {
  Sell: "/",
  Make: "/queue",
  Stock: "/resin",
  System: "/setup",
};

function groupForPath(path: string): NavGroup {
  return NAV.find((item) => item.href === path)?.group ?? "Sell";
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { isUnlocked, lock } = useOwnerSession();
  const activeGroup = groupForPath(location);
  const siblings = NAV.filter((item) => item.group === activeGroup);

  useEffect(() => {
    document.title = "Print Ops";
  }, [location]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      {/* Charcoal workbench command bar */}
      <header className="shrink-0 bg-sidebar text-sidebar-foreground">
        <div className="flex h-12 items-center gap-2 px-3 md:gap-3 md:px-4">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            data-testid="link-home"
            title="Print Ops"
          >
            <Mark className="h-6 w-6 text-sidebar-primary" />
            <span className="hidden text-sm font-semibold tracking-tight sm:inline">Print Ops</span>
          </Link>

          <div className="mx-1 hidden h-5 w-px bg-white/10 sm:block" aria-hidden />

          {/* Phase switcher — primary workflow organization */}
          <nav
            aria-label="Workflow phases"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-lg bg-black/25 p-0.5"
          >
            {GROUPS.map((group) => {
              const active = activeGroup === group;
              return (
                <Link
                  key={group}
                  href={GROUP_HOME[group]}
                  data-testid={`link-phase-${group.toLowerCase()}`}
                  className={cn(
                    "shrink-0 rounded-md px-2.5 py-1.5 text-xs font-semibold tracking-wide transition-colors sm:px-3",
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                      : "text-sidebar-foreground/65 hover:bg-white/5 hover:text-sidebar-foreground",
                  )}
                >
                  {group}
                </Link>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-1">
            <AttentionBell />
            <a
              href="https://app.hubspot.com/"
              target="_blank"
              rel="noopener noreferrer"
              title="HubSpot CRM"
              data-testid="link-sidebar-hubspot"
              className="hidden h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-white/10 hover:text-sidebar-foreground sm:inline-flex"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              HubSpot
            </a>
            <a
              href="https://ship.pirateship.com/"
              target="_blank"
              rel="noopener noreferrer"
              title="Pirate Ship"
              data-testid="link-sidebar-pirateship"
              className="hidden h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-white/10 hover:text-sidebar-foreground md:inline-flex"
            >
              <ShipWheel className="h-3.5 w-3.5" />
              Ship
            </a>
            <ThemeToggle testId="button-theme-toggle" />
            {isUnlocked ? (
              <button
                type="button"
                onClick={lock}
                title="Lock owner session"
                data-testid="button-lock-owner-session"
                className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-white/10 hover:text-sidebar-foreground"
              >
                <Lock className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Lock</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* Page chips for the active phase */}
        <div className="flex h-10 items-center gap-1 border-t border-white/10 bg-black/20 px-3 md:px-4">
          <span className="mr-1 hidden text-[0.625rem] font-bold uppercase tracking-[0.12em] text-sidebar-foreground/40 sm:inline">
            {activeGroup}
          </span>
          <nav aria-label={`${activeGroup} pages`} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {siblings.map((item) => {
              const active = location === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.title}
                  data-testid={item.testId}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-white/15 text-sidebar-foreground"
                      : "text-sidebar-foreground/60 hover:bg-white/8 hover:text-sidebar-foreground",
                  )}
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="scroll-pane min-h-0 min-w-0 flex-1">{children}</main>
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
}) {
  return (
    <header className="accent-wash sticky top-0 z-10 border-b border-border px-3 py-3 md:px-5">
      <div className="flex flex-wrap items-end justify-between gap-2.5">
        <div className="min-w-0">
          <h1
            className="truncate text-lg font-semibold tracking-tight text-foreground md:text-xl"
            data-testid="text-page-title"
          >
            {title}
          </h1>
          <p className="mt-0.5 max-w-2xl text-xs leading-4 text-muted-foreground md:text-sm md:leading-5">
            {subtitle}
          </p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
    </header>
  );
}
