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
  Users,
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
      <rect x="4" y="4" width="24" height="24" rx="3" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <path d="M8 22h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M10 17h12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity="0.75" />
      <path d="M12 12h8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity="0.5" />
      <circle cx="16" cy="7.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

/* ---------------------------------------------------------------- shell --- */

/** Shop-floor groups: Run the day, Take work in, Keep the shop stocked, Office for numbers. */
type NavGroup = "Run" | "Take" | "Keep" | "Office";

const NAV: Array<{
  href: string;
  label: string;
  title: string;
  icon: typeof LayoutDashboard;
  testId: string;
  group: NavGroup;
}> = [
  { href: "/", label: "Floor", title: "Today’s floor board", icon: LayoutDashboard, testId: "link-nav-home", group: "Run" },
  { href: "/queue", label: "Queue", title: "Production queue", icon: ListOrdered, testId: "link-nav-queue", group: "Run" },
  { href: "/deals", label: "Orders", title: "Print Orders board", icon: Boxes, testId: "link-nav-deals", group: "Run" },
  { href: "/prints", label: "Prints", title: "Plates & print files", icon: FileUp, testId: "link-nav-prints", group: "Run" },
  { href: "/clients", label: "Clients", title: "HubSpot clients", icon: Users, testId: "link-nav-clients", group: "Take" },
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
  { href: "/resin", label: "Resin", title: "Resin Inventory", icon: Beaker, testId: "link-nav-resin", group: "Keep" },
  { href: "/supplies", label: "Supplies", title: "Supply Spend", icon: ShoppingBag, testId: "link-nav-supplies", group: "Keep" },
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

/** Always-visible production loop — the mental model for Print Ops. */
const STAGES: Array<{ href: string; label: string; match: (path: string) => boolean }> = [
  {
    href: "/orders",
    label: "Intake",
    match: (path) => path === "/orders" || path === "/paid-orders" || path === "/clients",
  },
  { href: "/queue", label: "Queue", match: (path) => path === "/queue" || path === "/" },
  { href: "/prints", label: "Plates", match: (path) => path === "/prints" },
  { href: "/deals", label: "Board", match: (path) => path === "/deals" },
];

/**
 * Floor Board shell: production-first left rail + stage strip.
 * HubSpot stays CRM of record; this chrome mirrors how the shop actually runs.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { isUnlocked, lock } = useOwnerSession();
  const activeGroup = NAV.find((item) => item.href === location)?.group ?? "Run";

  useEffect(() => {
    document.title = "Print Ops";
  }, [location]);

  return (
    <div className="grid h-[100dvh] grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground md:grid-cols-[13rem_1fr] md:grid-rows-1">
      <aside className="flex min-w-0 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2.5 py-2 text-sidebar-foreground md:h-full md:flex-col md:items-stretch md:gap-3 md:border-b-0 md:border-r md:px-2 md:py-3">
        <div className="flex min-w-0 items-center gap-2 md:flex-col md:items-stretch md:gap-2">
          <Link
            href="/"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring md:px-1.5"
            data-testid="link-home"
            title="Print Ops"
          >
            <Mark className="h-7 w-7 shrink-0 text-sidebar-primary" />
            <span className="min-w-0 truncate">
              <span className="block text-[0.9375rem] font-semibold tracking-tight">Print Ops</span>
              <span className="hidden text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/45 md:block">
                Floor Board
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-1 md:justify-center">
            <AttentionBell />
            <ThemeToggle
              className="border-sidebar-border bg-sidebar-accent text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground md:hidden"
              testId="button-theme-toggle-mobile"
            />
          </div>
        </div>

        <nav
          aria-label="Primary navigation"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:block md:overflow-x-visible md:overflow-y-auto"
        >
          {GROUPS.map((group) => {
            const isActiveGroup = activeGroup === group.id;
            return (
              <div
                key={group.id}
                className={cn(
                  "flex shrink-0 items-center gap-0.5 md:mb-3 md:block md:rounded-lg md:px-0.5 md:py-0.5",
                  isActiveGroup && "md:bg-white/[0.04]",
                )}
              >
                <div className="hidden px-2 pb-1 pt-0.5 md:block">
                  <p
                    className={cn(
                      "text-[0.625rem] font-bold uppercase tracking-[0.14em]",
                      isActiveGroup ? "text-sidebar-primary" : "text-sidebar-foreground/35",
                    )}
                  >
                    {group.id}
                  </p>
                  <p className="text-[0.6rem] text-sidebar-foreground/30">{group.hint}</p>
                </div>
                {NAV.filter((item) => item.group === group.id).map((item) => {
                  const active = location === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.title}
                      data-testid={item.testId}
                      className={cn(
                        "relative flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-[0.8125rem] font-medium transition-colors md:mb-px md:w-full",
                        active
                          ? "bg-sidebar-primary/18 font-semibold text-sidebar-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-sm before:bg-sidebar-primary"
                          : "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                      )}
                    >
                      <item.icon className={cn("h-3.5 w-3.5 shrink-0", active && "text-sidebar-primary")} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="mt-auto hidden space-y-0.5 border-t border-sidebar-border pt-2 md:block">
          <p className="px-2 pb-1 text-[0.625rem] font-bold uppercase tracking-[0.14em] text-sidebar-foreground/35">
            CRM & ship
          </p>
          <a
            href="https://app.hubspot.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="HubSpot CRM"
            data-testid="link-sidebar-hubspot"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] font-medium text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            HubSpot
          </a>
          <a
            href="https://ship.pirateship.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="Pirate Ship"
            data-testid="link-sidebar-pirateship"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] font-medium text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ShipWheel className="h-3.5 w-3.5 shrink-0" />
            Ship
          </a>
          <ThemeToolButton />
          {isUnlocked ? (
            <button
              type="button"
              onClick={lock}
              title="Lock owner session"
              data-testid="button-lock-owner-session"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] font-medium text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Lock className="h-3.5 w-3.5 shrink-0" />
              Lock
            </button>
          ) : null}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col">
        <StageStrip location={location} />
        <main className="scroll-pane min-h-0 min-w-0 flex-1 bg-transparent">{children}</main>
      </div>
    </div>
  );
}

function StageStrip({ location }: { location: string }) {
  return (
    <div
      className="accent-wash flex items-center gap-2 border-b border-border px-3 py-1.5 md:px-4"
      data-testid="strip-production-stages"
      aria-label="Production stages"
    >
      <p className="hidden shrink-0 text-[0.625rem] font-bold uppercase tracking-[0.14em] text-muted-foreground sm:block">
        Loop
      </p>
      <div className="stage-strip min-w-0 flex-1">
        {STAGES.map((stage, index) => {
          const active = stage.match(location);
          return (
            <span key={`${stage.label}-${index}`} className="inline-flex items-center gap-1">
              {index > 0 ? <span className="stage-arrow" aria-hidden>→</span> : null}
              <Link
                href={stage.href}
                className="stage-chip"
                data-active={active ? "true" : "false"}
                data-testid={`link-stage-${stage.label.toLowerCase()}`}
              >
                <span className="numeric text-[0.6rem] opacity-70">{index + 1}</span>
                {stage.label}
              </Link>
            </span>
          );
        })}
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
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] font-medium text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
    >
      {theme === "dark" ? <Sun className="h-3.5 w-3.5 shrink-0" /> : <Moon className="h-3.5 w-3.5 shrink-0" />}
      Theme
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
