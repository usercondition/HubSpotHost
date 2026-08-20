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
        "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
    <div className="grid h-[100dvh] grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground md:grid-cols-[3.75rem_1fr] md:grid-rows-1">
      {/* Icon rail — workflow-grouped */}
      <aside className="flex min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar px-2 py-2 text-sidebar-foreground md:h-full md:flex-col md:gap-0 md:border-b-0 md:border-r md:px-1.5 md:py-3">
        <Link
          href="/"
          className="mb-0 flex shrink-0 items-center justify-center rounded-lg p-1.5 text-sidebar-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring md:mb-3"
          data-testid="link-home"
          title="Print Ops"
        >
          <Mark className="h-6 w-6" />
        </Link>

        <nav
          aria-label="Primary navigation"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex-col md:overflow-x-visible md:overflow-y-auto md:gap-0"
        >
          {GROUPS.map((group, groupIndex) => (
            <div key={group} className={cn("flex shrink-0 items-center gap-1 md:w-full md:flex-col md:gap-0.5", groupIndex > 0 && "md:mt-2 md:border-t md:border-sidebar-border md:pt-2")}>
              <p className="hidden w-full truncate px-0.5 pb-1 text-center text-[0.55rem] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/35 md:block">
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
                      "group/rail relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors md:mx-auto",
                      active
                        ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className="rail-tip hidden md:inline">{item.label}</span>
                    <span className="sr-only">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1 md:mt-auto md:flex-col md:gap-1 md:border-t md:border-sidebar-border md:pt-2">
          <div className="md:hidden">
            <AttentionBell />
          </div>
          <ThemeToggle className="border-sidebar-border bg-sidebar-accent text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground md:hidden" testId="button-theme-toggle-mobile" />
          <a
            href="https://app.hubspot.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="HubSpot CRM"
            data-testid="link-sidebar-hubspot"
            className="group/rail relative hidden h-9 w-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:flex"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="rail-tip">HubSpot</span>
          </a>
          <a
            href="https://ship.pirateship.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="Pirate Ship"
            data-testid="link-sidebar-pirateship"
            className="group/rail relative hidden h-9 w-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:flex"
          >
            <ShipWheel className="h-3.5 w-3.5" />
            <span className="rail-tip">Ship</span>
          </a>
          <ThemeToolButton />
          {isUnlocked ? (
            <button
              type="button"
              onClick={lock}
              title="Lock owner session"
              data-testid="button-lock-owner-session"
              className="group/rail relative hidden h-9 w-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:flex"
            >
              <Lock className="h-3.5 w-3.5" />
              <span className="rail-tip">Lock</span>
            </button>
          ) : null}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col">
        {/* Contextual stage strip — siblings in the active workflow group */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3 md:px-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="rule-label shrink-0 text-primary">{activeGroup}</span>
              <nav aria-label={`${activeGroup} pages`} className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
                {siblings.map((item) => {
                  const active = location === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      data-testid={`${item.testId}-stage`}
                      className={cn(
                        "shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                        active
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </div>
          </div>
          <div className="hidden items-center gap-1.5 md:flex">
            <AttentionBell />
            <span className="text-xs font-semibold tracking-tight text-foreground">Print Ops</span>
          </div>
        </div>

        <main className="scroll-pane min-h-0 min-w-0 flex-1">{children}</main>
      </div>
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
      className="group/rail relative hidden h-9 w-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:flex"
    >
      {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
      <span className="rail-tip">Theme</span>
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
    <header className="accent-wash sticky top-0 z-10 border-b border-border/80 px-3 py-3 md:px-5">
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
