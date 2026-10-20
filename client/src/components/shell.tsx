import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, Redirect, useLocation } from "wouter";
import {
  Activity,
  BarChart3,
  Boxes,
  ClipboardCheck,
  ExternalLink,
  FileUp,
  FolderSearch,
  LayoutDashboard,
  Library,
  Link2,
  ListChecks,
  ListOrdered,
  Lock,
  Menu,
  MessagesSquare,
  Moon,
  Radar,
  Printer,
  RefreshCw,
  Settings2,
  Ship,
  ShoppingBag,
  Sun,
  Tag,
  Calculator,
  ChevronLeft,
  ChevronRight,
  MessageSquareText,
} from "lucide-react";
import { AttentionBell } from "@/components/attention-bell";
import { HubspotSyncDialog } from "@/components/hubspot-sync-chip";
import { OpsAssistantSheet } from "@/components/ops-assistant-sheet";
import { PageTransition } from "@/components/page-transition";
import { PcOnlyNote } from "@/components/pc-only";
import { useIsPhone } from "@/hooks/use-is-phone";
import {
  PHONE_DESCRIPTIONS,
  PHONE_LABELS,
  PHONE_MORE_HREF,
  pcOnlyRouteFor,
  phoneBackTarget,
  phoneMoreSections,
  phoneTabs,
} from "@/lib/phone";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { useShopCounts } from "@/hooks/use-shop-counts";
import { queryClient } from "@/lib/queryClient";
import { formatPacificSnapshot, syncPillCopy } from "@/lib/sync-status";
import { cn } from "@/lib/utils";
import { NERVE_SECTION_ENABLED } from "@/lib/nerve";

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
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#171717" : "#FAFAFA");
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
  row = false,
}: {
  className?: string;
  testId?: string;
  rail?: boolean;
  /** Phone More page row: icon tile, label, one-line description. */
  row?: boolean;
}) {
  const { theme, toggle } = useContext(ThemeContext);
  const label = theme === "dark" ? "Light mode" : "Dark mode";
  if (row) {
    const Icon = theme === "dark" ? Sun : Moon;
    return (
      <button type="button" onClick={toggle} data-testid={testId} className={cn("more-row", className)}>
        <MoreRowBody icon={<Icon className="h-[18px] w-[18px]" />} label={label} description="Switch the app theme" />
      </button>
    );
  }
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


const APP_LINKS: Array<{ href: string; label: string; current?: boolean; testId: string }> = [
  { href: "https://miguels-mac-mini.tailc0d52c.ts.net/", label: "Paperclip", testId: "link-app-paperclip" },
  { href: "/", label: "Print Ops", current: true, testId: "link-app-printops" },
  { href: "https://app-na2.hubspot.com/contacts/246947621/objects/0-3/views/all/board", label: "HubSpot", testId: "link-app-hubspot" },
];

function AppSwitcher({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", compact && "flex-nowrap", className)} data-testid="app-switcher" aria-label="Apps">
      {APP_LINKS.map((a) =>
        a.current ? (
          <span
            key={a.label}
            data-testid={a.testId}
            aria-current="page"
            className={cn(
              "inline-flex h-7 items-center rounded-md border border-border/60 bg-muted px-2 text-[12px] font-medium text-foreground",
              compact && "shrink-0 px-1.5",
            )}
          >
            {a.label}
          </span>
        ) : (
          <a
            key={a.label}
            href={a.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={a.testId}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              compact && "shrink-0 px-1.5",
            )}
          >
            {a.label}
            <ExternalLink className={cn("h-3 w-3 opacity-60", compact && "hidden xl:block")} />
          </a>
        ),
      )}
    </div>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Print Ops"
      role="img"
      className={className}
    >
      <rect width="32" height="32" rx="7.04" fill="#1c1917" />
      <path d="M11.648 11.648A4.352 4.352 0 0 0 20.352 11.648Z" fill="#f59e0b" />
      <rect x="10.24" y="12.576" width="11.52" height="1.6" rx="0.8" fill="#f59e0b" />
      <rect x="9.12" y="15.104" width="13.76" height="1.6" rx="0.8" fill="#f59e0b" />
      <rect x="8.224" y="17.632" width="15.552" height="1.6" rx="0.8" fill="#f59e0b" />
      <rect x="7.392" y="20.16" width="17.216" height="1.6" rx="0.8" fill="#f59e0b" />
      <rect x="6.704" y="22.688" width="18.592" height="1.92" rx="0.96" fill="#f59e0b" />
    </svg>
  );
}

/* ------------------------------------------------------ phone More rows --- */

function MoreRowBody({
  icon,
  label,
  description,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      <span className="more-row-icon" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="more-row-label">{label}</span>
        {description ? <span className="more-row-desc">{description}</span> : null}
      </span>
      {trailing}
      <ChevronRight className="more-row-chevron" aria-hidden />
    </>
  );
}

/* ---------------------------------------------------------------- shell --- */

type NavGroup = "Run" | "Take" | "Keep";

const NAV: Array<{
  href: string;
  label: string;
  title: string;
  icon: typeof LayoutDashboard;
  testId: string;
  group: NavGroup;
  phone?: "tab" | "more" | "never";
}> = [
  { href: "/", label: "Hub", title: "Orders, production flow, and priority", icon: LayoutDashboard, testId: "link-nav-home", group: "Run", phone: "tab" },
  { href: "/prints", label: "Print files", title: "Plates & print files", icon: FileUp, testId: "link-nav-prints", group: "Run", phone: "tab" },
  { href: "/printers", label: "Printers", title: "Printers", icon: Printer, testId: "link-nav-printers", group: "Run", phone: "tab" },
  { href: "/labels", label: "Labels", title: "Shipping labels", icon: Tag, testId: "link-nav-labels", group: "Run", phone: "more" },
  { href: "/inbox", label: "Inbox", title: "Client chats and follow-ups", icon: MessagesSquare, testId: "link-nav-inbox", group: "Take", phone: "more" },
  { href: "/orders", label: "Intake", title: "Paid Order Intake", icon: Link2, testId: "link-nav-order-links", group: "Take", phone: "more" },
  { href: "/quote", label: "Quote", title: "STL Quote", icon: Calculator, testId: "link-nav-quote", group: "Take", phone: "more" },
  { href: "/files", label: "Files", title: "Search Drive files", icon: FolderSearch, testId: "link-nav-files", group: "Take", phone: "more" },
  { href: "/spending", label: "Spending", title: "Supplies, overhead and the bottom line", icon: ShoppingBag, testId: "link-nav-spending", group: "Keep", phone: "more" },
  { href: "/setup", label: "Setup", title: "System Setup", icon: Settings2, testId: "link-nav-setup", group: "Keep", phone: "more" },
];

const GROUPS: Array<{ id: NavGroup; hint: string }> = [
  { id: "Run", hint: "Today’s work" },
  { id: "Take", hint: "Buyers in" },
  { id: "Keep", hint: "Machines & stock" },
];

// Phone nav is built from lib/phone.ts (on-the-go tasks), not the desktop groups.
// Contextual and PC-only pages are left out.
const PHONE_TABS = phoneTabs(NAV);
const PHONE_MORE_SECTIONS = phoneMoreSections(NAV);
const PHONE_MORE = PHONE_MORE_SECTIONS.flatMap((section) => section.items);
const phoneLabel = (item: { href: string; label: string }) => PHONE_LABELS[item.href] ?? item.label;

type ShopCounts = ReturnType<typeof useShopCounts>;

function navCountFor(shop: ShopCounts, href: string): { value: number | null; hot?: boolean; testId?: string } | null {
  if (href === "/") return { value: shop.needsYou, hot: true, testId: "badge-nav-floor" };
  return null;
}

const FROM_MORE_KEY = "print-ops-from-more";

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
  const emphasize = Boolean(hot && value != null && value > 0);
  return (
    <span
      className={cn("nav-count numeric", emphasize && "nav-count-hot")}
      data-testid={testId}
      data-count-slot="nav"
      aria-hidden={value == null ? true : undefined}
    >
      {value == null ? "" : value}
    </span>
  );
}

/** Old routes that now open a tab of a merged page; the nav highlights the merged page. */
const NAV_ALIASES: Record<string, string> = {
  "/supplies": "/spending",
  "/expenses": "/spending",
  "/spending/overhead": "/spending",
};

export function AppShell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const routePath = location.split("?")[0] || "/";
  const pathOnly = NAV_ALIASES[routePath] ?? routePath;
  const { isUnlocked, lock } = useOwnerSession();
  const shop = useShopCounts();
  const activeItem = NAV.find((item) => item.href === pathOnly);
  const activeGroup = activeItem?.group ?? "Run";
  const onMorePage = pathOnly === PHONE_MORE_HREF;
  const moreActive = onMorePage || PHONE_MORE.some((item) => item.href === pathOnly);
  const backTo = phoneBackTarget(pathOnly, PHONE_MORE.map((item) => item.href));
  const isPhone = useIsPhone();
  // On a phone, PC-only pages show a short "Do this on your PC" note instead.
  const pcOnly = isPhone ? pcOnlyRouteFor(routePath) : null;

  useEffect(() => {
    document.title = activeItem ? `${activeItem.label} · Print Ops` : onMorePage ? "More · Print Ops" : "Print Ops";
  }, [pathOnly, activeItem, onMorePage]);

  useEffect(() => {
    if (!isUnlocked) return;
    const timer = window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["/api/performance"], refetchType: "active" });
      void queryClient.invalidateQueries({ queryKey: ["/api/production-queue"], refetchType: "active" });
      void queryClient.invalidateQueries({ queryKey: ["/api/priority-stack"], refetchType: "active" });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [pathOnly, isUnlocked]);

  const countFor = (href: string) => navCountFor(shop, href);

  // Phone Back on a page opened from More: pop history when we came from More, else go to More.
  const goBack = () => {
    let fromMore: string | null = null;
    try {
      fromMore = window.sessionStorage.getItem(FROM_MORE_KEY);
      window.sessionStorage.removeItem(FROM_MORE_KEY);
    } catch {
      /* private mode */
    }
    if (fromMore === pathOnly && window.history.length > 1) window.history.back();
    else navigate(PHONE_MORE_HREF);
  };

  return (
    <div className="ops-shell flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground md:flex-row" data-nav-group={activeGroup.toLowerCase()}>
      <aside className="ops-rail hidden md:flex">
        <Link href="/" className="ops-brand" data-testid="link-home" title="Print Ops">
          <span className="ops-mark-wrap">
            <Mark className="h-full w-full" />
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
              {NAV.filter((item) => item.group === group.id && !(isPhone && pcOnlyRouteFor(item.href))).map((item) => {
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
                    <NavCount
                      value={count?.value ?? null}
                      hot={count?.hot}
                      testId={count?.testId ?? `badge-nav-${item.label.toLowerCase()}`}
                    />
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="ops-rail-foot">
          <OpsAssistantSheet rail />
          <ThemeToggle rail />
          <div className="px-2 pb-1">
            <p className="ops-rail-label">Apps</p>
            <AppSwitcher className="flex-col items-stretch" />
          </div>
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
            <AppSwitcher className="mr-1 hidden lg:flex" compact />
            <SyncPill />
            <AttentionBell />
            <RefreshButton testId="button-refresh-workspace" />
          </div>
        </header>

        <header className="ops-phone-bar flex md:hidden">
          {backTo && isPhone ? (
            <button
              type="button"
              onClick={goBack}
              className="ops-phone-back"
              data-testid="button-phone-back"
              aria-label="Back to More"
              title="Back to More"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          ) : null}
          <Link href="/" className="flex min-w-0 items-center gap-2" data-testid="link-home-mobile" title="Print Ops">
            <span className="ops-mark-wrap h-[26px] w-[26px] rounded-[7px]">
              <Mark className="h-full w-full" />
            </span>
            <span className="truncate text-[17px] font-semibold tracking-tight" data-testid="text-phone-title">
              {activeItem ? phoneLabel(activeItem) : onMorePage ? "More" : "Print Ops"}
            </span>
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
          <PageTransition routeKey={pathOnly}>
            {pcOnly ? <PcOnlyNote what={pcOnly.what} alt={pcOnly.alt} /> : children}
          </PageTransition>
        </main>


        <nav aria-label="Mobile navigation" className="ops-tabbar grid md:hidden">
          {PHONE_TABS.map((item) => {
            const active = pathOnly === item.href;
            const count = countFor(item.href);
            const badge = count?.value != null && count.value > 0 ? count.value : null;
            const phoneTestId =
              item.href === "/" ? "badge-phone-floor" : item.href === "/queue" ? "badge-phone-queue" : null;
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
                  {badge != null && phoneTestId ? (
                    <span
                      className={cn("ops-tab-badge numeric", count?.hot && "nav-count-hot")}
                      data-testid={phoneTestId}
                      data-count-slot="phone"
                    >
                      {badge > 9 ? "9+" : badge}
                    </span>
                  ) : null}
                </span>
                <span>{phoneLabel(item)}</span>
              </Link>
            );
          })}
          <Link
            href={PHONE_MORE_HREF}
            className="ops-tab"
            data-active={moreActive ? "true" : "false"}
            data-testid="button-mobile-nav-more"
            aria-current={onMorePage ? "page" : undefined}
          >
            <Menu className="h-5 w-5" />
            <span>More</span>
          </Link>
        </nav>
      </div>
    </div>
  );
}

/**
 * Phone More page (#/more): every on-the-go page not in the tab bar, grouped
 * Orders / Make / Shop, then Tools and Apps. Desktop never shows it (the rail
 * has everything), so a PC opening #/more lands on the Work hub.
 */
export function MorePage() {
  const isPhone = useIsPhone();
  const shop = useShopCounts();
  const rememberFromMore = (href: string) => {
    try {
      window.sessionStorage.setItem(FROM_MORE_KEY, href);
    } catch {
      /* private mode */
    }
  };
  if (!isPhone) return <Redirect to="/" />;
  return (
    <div className="more-page" data-testid="page-more">
      {PHONE_MORE_SECTIONS.map((section) => (
        <section key={section.title} className="more-section" data-testid={`group-phone-more-${section.title.toLowerCase()}`}>
          <h2 className="more-heading">{section.title}</h2>
          <div className="more-card">
            {section.items.map((item) => {
              const count = navCountFor(shop, item.href);
              const value = count?.value != null && count.value > 0 ? count.value : null;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="more-row"
                  data-testid={`link-phone-${item.label.toLowerCase()}`}
                  onClick={() => rememberFromMore(item.href)}
                >
                  <MoreRowBody
                    icon={<item.icon className="h-[18px] w-[18px]" />}
                    label={phoneLabel(item)}
                    description={PHONE_DESCRIPTIONS[item.href]}
                    trailing={
                      value != null ? (
                        <span
                          className={cn("nav-count numeric", count?.hot && "nav-count-hot")}
                          data-testid={item.href === "/stack" ? "badge-phone-stack" : `badge-phone-${item.label.toLowerCase()}`}
                        >
                          {value}
                        </span>
                      ) : null
                    }
                  />
                </Link>
              );
            })}
          </div>
        </section>
      ))}
      <section className="more-section" data-testid="group-phone-more-tools">
        <h2 className="more-heading">Tools</h2>
        <div className="more-card">
          <OpsAssistantSheet
            row={<MoreRowBody icon={<MessageSquareText className="h-[18px] w-[18px]" />} label="Ask Ops" description="Quick answers on queue, labels, plates" />}
          />
          <ThemeToggle row testId="button-theme-toggle-more" />
        </div>
      </section>
      <section className="more-section" data-testid="group-phone-more-apps">
        <h2 className="more-heading">Apps</h2>
        <div className="more-card">
          {APP_LINKS.filter((app) => !app.current).map((app) => (
            <a key={app.label} href={app.href} target="_blank" rel="noopener noreferrer" className="more-row" data-testid={app.testId}>
              <MoreRowBody
                icon={<ExternalLink className="h-[18px] w-[18px]" />}
                label={app.label}
                description={app.label === "HubSpot" ? "Open the HubSpot deal board" : "Agents and tasks on the Mac mini"}
              />
            </a>
          ))}
        </div>
      </section>
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
          <div className={cn("flex min-w-0 max-w-full flex-wrap items-center gap-1.5", hideActionsOnPhone && "max-md:hidden")}>{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
