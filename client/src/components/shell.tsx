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
        "inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
  System: "/performance",
};

function groupForPath(path: string): NavGroup {
  return NAV.find((item) => item.href === path)?.group ?? "Sell";
}

/**
 * Single chrome: phase switcher + pages for that phase + tools.
 * Removes the redundant bottom dock + second chip row.
 */
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
      <header className="shrink-0 border-b border-border bg-card">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 md:px-4">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="link-home"
            title="Print Ops"
          >
            <Mark className="h-5 w-5 text-primary" />
            <span className="text-sm font-semibold tracking-tight">Print Ops</span>
          </Link>

          <nav
            aria-label="Workflow phases"
            className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/70 p-0.5"
          >
            {GROUPS.map((group) => {
              const active = activeGroup === group;
              return (
                <Link
                  key={group}
                  href={GROUP_HOME[group]}
                  data-testid={`link-phase-${group.toLowerCase()}`}
                  className={cn(
                    "rounded px-2 py-1 text-[0.6875rem] font-semibold tracking-wide transition-colors",
                    active
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {group}
                </Link>
              );
            })}
          </nav>

          <nav
            aria-label={`${activeGroup} pages`}
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          >
            {siblings.map((item) => {
              const active = location === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.title}
                  data-testid={item.testId}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <item.icon className={cn("h-3.5 w-3.5", active && "text-primary")} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <AttentionBell />
            <a
              href="https://app.hubspot.com/"
              target="_blank"
              rel="noopener noreferrer"
              title="HubSpot CRM"
              data-testid="link-sidebar-hubspot"
              className="hidden h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
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
              className="hidden h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:inline-flex"
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
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Lock className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Lock</span>
              </button>
            ) : null}
          </div>
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
    <header className="accent-wash sticky top-0 z-10 border-b border-border px-3 py-2 md:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1
            className="truncate text-base font-semibold tracking-tight text-foreground md:text-lg"
            data-testid="text-page-title"
          >
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-0.5 max-w-3xl truncate text-xs text-muted-foreground md:whitespace-normal">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
    </header>
  );
}
