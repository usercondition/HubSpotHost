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
  theme: "dark",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    const saved = window.localStorage.getItem("print-ops-theme");
    if (saved === "light" || saved === "dark") return saved;
    return "dark";
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
        "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card/80 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
      <rect x="3.5" y="3.5" width="25" height="25" rx="7" stroke="currentColor" strokeWidth="1.8" opacity="0.35" />
      <path d="M9 22h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M11 17h10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.75" />
      <path d="M13 12h6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.5" />
      <circle cx="16" cy="8" r="1.7" fill="currentColor" />
    </svg>
  );
}

/* ---------------------------------------------------------------- shell --- */

/** Shop-floor groups preserved — same routes, Railway workspace chrome. */
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
 * Workspace shell — Railway-inspired canvas for Print Ops.
 * Icon rail + top project bar + stage loop. HubSpot remains CRM of record.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { isUnlocked, lock } = useOwnerSession();
  const activeGroup = NAV.find((item) => item.href === location)?.group ?? "Run";
  const activeItem = NAV.find((item) => item.href === location);

  useEffect(() => {
    document.title = activeItem ? `${activeItem.label} · Print Ops` : "Print Ops";
  }, [location, activeItem]);

  return (
    <div className="grid h-[100dvh] grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground md:grid-cols-[4.25rem_1fr] md:grid-rows-[auto_1fr]">
      {/* Top project bar — Railway header energy */}
      <header className="accent-wash col-span-full z-20 flex items-center gap-3 border-b border-border px-3 py-2 md:px-4">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="link-home"
          title="Print Ops"
        >
          <Mark className="h-7 w-7 shrink-0 text-primary" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold tracking-tight">Print Ops</span>
            <span className="hidden text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:block">
              Workspace · shop floor
            </span>
          </span>
        </Link>

        <span className="status-live hidden sm:inline-flex" data-testid="status-workspace-live">
          Online
        </span>

        <div className="mx-auto hidden min-w-0 flex-1 justify-center md:flex">
          <StageStrip location={location} />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <AttentionBell />
          <ThemeToggle />
          {isUnlocked ? (
            <button
              type="button"
              onClick={lock}
              title="Lock owner session"
              data-testid="button-lock-owner-session"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card/80 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Lock className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Lock</span>
            </button>
          ) : null}
        </div>
      </header>

      {/* Icon rail — Railway left toolbar */}
      <aside className="hidden min-h-0 flex-col items-center gap-1 overflow-x-hidden border-r border-sidebar-border bg-sidebar/95 px-1.5 py-3 text-sidebar-foreground backdrop-blur-md md:flex">
        <nav
          aria-label="Primary navigation"
          className="flex w-full min-h-0 flex-1 flex-col items-center gap-3 overflow-x-hidden overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {GROUPS.map((group) => {
            const isActiveGroup = activeGroup === group.id;
            return (
              <div key={group.id} className="flex w-full flex-col items-center gap-0.5">
                <p
                  className={cn(
                    "mb-0.5 text-[0.55rem] font-bold uppercase tracking-[0.14em]",
                    isActiveGroup ? "text-sidebar-primary" : "text-sidebar-foreground/30",
                  )}
                  title={group.hint}
                >
                  {group.id}
                </p>
                {NAV.filter((item) => item.group === group.id).map((item) => {
                  const active = location === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={`${item.label} — ${item.title}`}
                      data-testid={item.testId}
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-xl transition-all",
                        active
                          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-[0_0_0_1px_hsl(var(--sidebar-primary)/0.5)]"
                          : "text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col items-center gap-0.5 border-t border-sidebar-border pt-2">
          <a
            href="https://app.hubspot.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="HubSpot CRM"
            data-testid="link-sidebar-hubspot"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <a
            href="https://ship.pirateship.com/"
            target="_blank"
            rel="noopener noreferrer"
            title="Pirate Ship"
            data-testid="link-sidebar-pirateship"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ShipWheel className="h-4 w-4" />
          </a>
        </div>
      </aside>

      {/* Mobile stage + horizontal nav */}
      <div className="flex min-h-0 min-w-0 flex-col md:col-start-2">
        <div className="accent-wash border-b border-border px-3 py-1.5 md:hidden">
          <StageStrip location={location} />
        </div>
        <nav
          aria-label="Mobile navigation"
          className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5 md:hidden"
        >
          {NAV.map((item) => {
            const active = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.title}
                data-testid={item.testId}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-medium",
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
        </nav>

        <main className="scroll-pane min-h-0 min-w-0 flex-1 bg-transparent">{children}</main>
      </div>
    </div>
  );
}

function StageStrip({ location }: { location: string }) {
  return (
    <div className="stage-strip min-w-0" data-testid="strip-production-stages" aria-label="Production stages">
      {STAGES.map((stage, index) => {
        const active = stage.match(location);
        return (
          <span key={`${stage.label}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 ? (
              <span className="stage-arrow" aria-hidden>
                →
              </span>
            ) : null}
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
    <header className="accent-wash sticky top-0 z-10 border-b border-border px-3 py-2.5 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="rule-label mb-0.5">Workspace</p>
          <h1
            className="truncate text-lg font-semibold tracking-tight text-foreground md:text-xl"
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
