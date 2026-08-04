import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Activity, ClipboardCheck, Link2, Moon, Settings2, Sun } from "lucide-react";
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
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      aria-label="Print Orders Margin Service"
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
  { href: "/", label: "Order links", icon: Link2, testId: "link-nav-order-links" },
  { href: "/operations", label: "Operations", icon: Activity, testId: "link-nav-operations" },
  { href: "/paid-orders", label: "Conversation intake", icon: ClipboardCheck, testId: "link-nav-paid-orders" },
  { href: "/setup", label: "Setup", icon: Settings2, testId: "link-nav-setup" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="grid h-[100dvh] grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground md:grid-cols-[13.5rem_1fr] md:grid-rows-1">
      <aside className="flex min-w-0 shrink-0 items-center gap-3 border-b border-sidebar-border bg-sidebar px-4 py-3 md:h-full md:flex-col md:items-stretch md:gap-6 md:border-b-0 md:border-r md:px-3 md:py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md md:px-1"
          data-testid="link-home"
        >
          <Mark className="h-7 w-7 text-primary" />
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">Margin Service</span>
            <span className="rule-label">Print Orders</span>
          </span>
        </Link>

        {/* On phones the nav becomes a horizontally scrollable strip so it cannot widen the grid. */}
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex-col md:items-stretch md:gap-0.5 md:overflow-visible">
          {NAV.map((item) => {
            const active = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={item.testId}
                className={cn(
                  "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden md:block">
          <p className="rule-label px-2.5">Deal fields</p>
          <ul className="mt-2 space-y-1 px-2.5 numeric text-[0.6875rem] text-muted-foreground">
            <li>amount</li>
            <li>print_material_cost</li>
            <li>print_labor_cost</li>
            <li>print_packaging_cost</li>
            <li>print_actual_shipping_cost</li>
          </ul>
        </div>
      </aside>

      <main className="scroll-pane min-w-0">{children}</main>
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
    <header className="amber-wash sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight" data-testid="text-page-title">
            {title}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </header>
  );
}
