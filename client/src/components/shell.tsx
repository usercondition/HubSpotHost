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
  Home,
  Link2,
  FileUp,
  Moon,
  Printer,
  ShoppingBag,
  Settings2,
  ShipWheel,
  Sun,
} from "lucide-react";
import { AttentionBell } from "@/components/attention-bell";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- theme --- */

type Theme = "dark" | "light";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "dark",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  }, [theme]);

  const value = useMemo(
    () => ({ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const { theme, toggle } = useContext(ThemeContext);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      data-testid="button-theme-toggle"
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  { href: "/", label: "Home", title: "Command Center", icon: Home, testId: "link-nav-home", group: "Work" },
  { href: "/deals", label: "Orders", title: "Print Orders board", icon: Boxes, testId: "link-nav-deals", group: "Work" },
  { href: "/orders", label: "Intake", title: "Paid Order Intake", icon: Link2, testId: "link-nav-order-links", group: "Work" },
  {
    href: "/paid-orders",
    label: "Manual",
    title: "Manual Order Entry",
    icon: ClipboardCheck,
    testId: "link-nav-paid-orders",
    group: "Work",
  },
  { href: "/supplies", label: "Supplies", title: "Supply Spend", icon: ShoppingBag, testId: "link-nav-supplies", group: "Work" },
  { href: "/prints", label: "Prints", title: "Print Files", icon: FileUp, testId: "link-nav-prints", group: "Work" },
  { href: "/printers", label: "Printers", title: "Printer Fleet", icon: Printer, testId: "link-nav-printers", group: "Work" },
  { href: "/resin", label: "Resin", title: "Resin Inventory", icon: Beaker, testId: "link-nav-resin", group: "Work" },
  { href: "/operations", label: "Profit", title: "Profit Automation", icon: Activity, testId: "link-nav-operations", group: "System" },
  { href: "/performance", label: "Stats", title: "Performance", icon: BarChart3, testId: "link-nav-performance", group: "System" },
  { href: "/setup", label: "Setup", title: "System Setup", icon: Settings2, testId: "link-nav-setup", group: "System" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const groups = Array.from(new Set(NAV.map((item) => item.group)));

  useEffect(() => {
    document.title = "Print Operations";
  }, [location]);

  return (
    <div className="grid h-[100dvh] grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground md:grid-cols-[8.75rem_1fr] md:grid-rows-1">
      <aside className="flex min-w-0 shrink-0 items-center gap-3 border-b border-sidebar-border bg-sidebar/95 px-3 py-3 backdrop-blur-sm md:h-full md:flex-col md:items-stretch md:gap-4 md:border-b-0 md:border-r md:px-2 md:py-4">
        <div className="flex min-w-0 items-center gap-2 md:flex-col md:items-stretch md:gap-2">
          <Link
            href="/"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex-col md:px-1 md:pt-1"
            data-testid="link-home"
            title="Print Operations"
          >
            <Mark className="h-7 w-7 shrink-0 text-primary" />
            <span className="flex min-w-0 flex-col leading-tight md:items-center md:text-center">
              <span className="truncate text-sm font-semibold tracking-tight md:text-xs">Print Ops</span>
              <span className="rule-label hidden sm:inline md:hidden">Owner hub</span>
            </span>
          </Link>
          <div className="md:flex md:justify-center">
            <AttentionBell />
          </div>
        </div>

        {/* On phones the nav remains a compact horizontal strip. */}
        <nav
          aria-label="Primary navigation"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:block md:overflow-visible"
        >
          {groups.map((group) => (
            <div key={group} className="flex shrink-0 items-center gap-1 md:mb-3 md:block">
              <p className="hidden px-2 pb-1.5 pt-1 rule-label md:block">{group}</p>
              {NAV.filter((item) => item.group === group).map((item) => {
                const active = location === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={item.title}
                    data-testid={item.testId}
                    className={cn(
                      "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-sm transition-colors md:mb-0.5 md:flex-col md:gap-1 md:px-2 md:py-2.5 md:text-center",
                      active
                        ? "bg-primary/10 font-medium text-foreground ring-1 ring-inset ring-primary/25"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="text-xs font-medium tracking-tight">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto hidden space-y-1 border-t border-sidebar-border pt-3 md:block">
          <p className="rule-label px-2 pb-1">Tools</p>
          <a
            href="https://app.hubspot.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="HubSpot CRM"
            data-testid="link-sidebar-hubspot"
            className="flex flex-col items-center gap-1 rounded-md px-2 py-2 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">HubSpot</span>
          </a>
          <a
            href="https://ship.pirateship.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="Pirate Ship"
            data-testid="link-sidebar-pirateship"
            className="flex flex-col items-center gap-1 rounded-md px-2 py-2 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <ShipWheel className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Ship</span>
          </a>
        </div>
      </aside>

      <main className="scroll-pane min-w-0 bg-transparent">{children}</main>
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
    <header className="accent-wash sticky top-0 z-10 border-b border-border bg-background/90 px-4 py-3.5 backdrop-blur-md md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight" data-testid="text-page-title">
            {title}
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm leading-5 text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </header>
  );
}
