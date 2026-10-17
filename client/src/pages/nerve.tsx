import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { Activity, ArrowLeft, Bot, HeartPulse, LayoutDashboard, Lock, MessagesSquare, Radar, RefreshCw, WifiOff } from "lucide-react";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getNerveKey, nerveGet, onNerveKeyChange, setNerveKey } from "@/lib/nerve";
import type { NerveError, NerveModel, NerveTile } from "@/lib/nerve";

type Tone = "neutral" | "good" | "warn" | "bad";
const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "chat", label: "Chat", icon: MessagesSquare },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "health", label: "Health", icon: HeartPulse },
] as const;
type TabId = (typeof TABS)[number]["id"];

const toneOf = (s: string | undefined): Tone => {
  const v = String(s || "").toLowerCase();
  if (["ok", "up", "green", "running", "idle", "good"].includes(v)) return "good";
  if (["red", "down", "bad", "error", "failed"].includes(v)) return "bad";
  if (["stale", "grace", "warn", "yellow", "late", "paused"].includes(v)) return "warn";
  return "neutral";
};
const age = (s?: number) => (s == null ? "" : s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`);

function useNerveKey() {
  const [k, setK] = useState(getNerveKey());
  useEffect(() => onNerveKeyChange(() => setK(getNerveKey())), []);
  return k;
}

function Unlock() {
  const [v, setV] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNerveKey(v);
    setV("");
  };
  return (
    <Panel title="Unlock Nerve" description="Held in this tab's memory only. Works only on a device connected to Tailscale." testId="panel-nerve-unlock">
      <form onSubmit={submit} className="flex max-w-md items-center gap-2">
        <Input type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder="Nerve key" data-testid="input-nerve-key" />
        <Button type="submit" data-testid="button-nerve-unlock">
          <Lock className="mr-1 h-4 w-4" /> Unlock
        </Button>
      </form>
    </Panel>
  );
}

function ErrorState({ err, retry }: { err: NerveError; retry: () => void }) {
  return (
    <Panel title={err.kind === "offline" ? "Connect Tailscale" : "Nerve unavailable"} description={err.message} testId="panel-nerve-error">
      <div className="flex items-center gap-2">
        <StatusPill tone={err.kind === "offline" ? "warn" : "bad"} icon={WifiOff} label={err.kind === "offline" ? "Off tailnet" : "Error"} />
        <Button variant="outline" size="sm" onClick={retry} data-testid="button-nerve-retry">
          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    </Panel>
  );
}

function TileRow({ t }: { t: NerveTile }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0" data-testid={`row-nerve-tile-${t.id}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{t.title}</p>
        <p className="truncate text-xs text-muted-foreground">{[t.value, age(t.ageS)].filter(Boolean).join(" · ")}</p>
      </div>
      <StatusPill tone={toneOf(t.state)} label={t.state} />
    </div>
  );
}

function Overview({ m }: { m: NerveModel }) {
  const v = m.verdict;
  const running = m.agents.filter((a) => a.status === "running").length;
  const sections = m.glance.sections.filter((s) => !["leads", "money"].includes(s.id));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="System" value={v.systemRed.length ? `${v.systemRed.length} red` : "All clear"} hint={v.systemRed.join(", ") || "No red checks"} icon={Activity} tone={v.systemRed.length ? "bad" : "good"} testId="stat-nerve-system" />
        <StatCard label="Stale / unknown" value={`${v.stale.length} / ${v.unknown.length}`} hint={[...v.stale, ...v.unknown].join(", ") || "Fresh"} icon={HeartPulse} tone={v.stale.length || v.unknown.length ? "warn" : "good"} testId="stat-nerve-stale" />
        <StatCard label="Needs you" value={String(v.needs)} hint="Open items on the Nerve board" icon={LayoutDashboard} tone={v.needs ? "warn" : "good"} testId="stat-nerve-needs" />
        <StatCard label="Agents running" value={`${running} / ${m.agents.length}`} hint="Paperclip agents" icon={Bot} testId="stat-nerve-agents" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((s) => (
          <Panel key={s.id} title={s.title} testId={`panel-nerve-section-${s.id}`}>
            {s.tiles.map((t) => (
              <TileRow key={t.id} t={t} />
            ))}
          </Panel>
        ))}
      </div>
    </div>
  );
}

function Health({ m }: { m: NerveModel }) {
  const r = m.refresh;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Healthchecks" description="Pings from Mac mini jobs" testId="panel-nerve-hc">
        {m.hc.map((h) => (
          <div key={h.name} className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
            <p className="min-w-0 truncate text-sm text-foreground">{h.name}</p>
            <StatusPill tone={toneOf(h.status)} label={h.status} />
          </div>
        ))}
      </Panel>
      <Panel title="Mac mini services" description={r ? `FB inbox data ${Math.round(r.dataAgeMs / 60000)}m old${r.running ? " · refreshing" : ""}` : undefined} testId="panel-nerve-services">
        {m.services.map((s) => (
          <div key={s.name} className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{s.name}</p>
              {s.red ? <p className="truncate text-xs text-bad">{s.red}</p> : null}
            </div>
            <StatusPill tone={toneOf(s.state)} label={s.state} />
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Coming({ what }: { what: string }) {
  return (
    <Panel title="Not here yet" description={what} testId="panel-nerve-coming">
      <a className="text-sm underline" href="https://miguels-mac-mini.tailc0d52c.ts.net/nerve/" target="_blank" rel="noopener noreferrer">
        Open Nerve v3
      </a>
    </Panel>
  );
}

export default function NervePage() {
  const [, params] = useRoute<{ tab: string }>("/nerve/:tab");
  const tab: TabId = (TABS.find((t) => t.id === params?.tab)?.id ?? "overview") as TabId;
  const key = useNerveKey();
  const q = useQuery<NerveModel, NerveError>({
    queryKey: ["nerve", "/api/v3", key],
    queryFn: () => nerveGet<NerveModel>("/api/v3"),
    enabled: !!key && (tab === "overview" || tab === "health"),
    refetchInterval: 60_000,
    retry: false,
  });

  const body =
    tab === "chat" ? (
      <Coming what="FB Marketplace Chat (inbox, send under the Mac mini lock, archive/delete) lands in a later phase. Use Nerve v3 meanwhile." />
    ) : tab === "agents" ? (
      <Coming what="Agents (Paperclip/Hermes runs, Intern digests) lands in a later phase." />
    ) : !key ? (
      <Unlock />
    ) : q.isLoading ? (
      <Skeleton className="h-64 w-full" />
    ) : q.error ? (
      <ErrorState err={q.error} retry={() => q.refetch()} />
    ) : q.data ? (
      tab === "health" ? <Health m={q.data} /> : <Overview m={q.data} />
    ) : null;
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="ops-shell flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground md:flex-row" data-testid="nerve-window">
      {/* Desktop: Nerve's own sidebar. No Print Ops nav, labels or app list in here. */}
      <aside className="ops-rail hidden md:flex" aria-label="Nerve">
        <div className="ops-brand" data-testid="nerve-brand">
          <span className="ops-mark-wrap">
            <Radar className="h-4 w-4 text-primary-foreground" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold tracking-tight text-foreground">Nerve</span>
            <span className="block truncate text-[11px] text-[hsl(var(--text-3))]">Mac mini · read-only</span>
          </span>
        </div>
        <nav aria-label="Nerve navigation" className="ops-rail-nav" data-testid="nav-nerve-sub">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={`/nerve/${t.id}`}
              data-testid={`link-nerve-${t.id}`}
              aria-current={tab === t.id ? "page" : undefined}
              className={cn("ops-rail-link", tab === t.id && "bg-[hsl(var(--raised))] font-semibold text-foreground")}
            >
              <t.icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{t.label}</span>
            </Link>
          ))}
        </nav>
        <div className="ops-rail-foot">
          <Link href="/" className="ops-rail-link" data-testid="link-nerve-back">
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span className="truncate">Back to Print Ops</span>
          </Link>
        </div>
      </aside>

      {/* Phone: Nerve top bar with Back, bottom tabs. */}
      <header className="ops-phone-bar flex items-center justify-between md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <span className="ops-mark-wrap">
            <Radar className="h-4 w-4 text-primary-foreground" />
          </span>
          <span className="truncate text-[15px] font-semibold">Nerve · {current.label}</span>
        </div>
        <Link href="/" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted" data-testid="link-nerve-back-mobile">
          <ArrowLeft className="h-4 w-4" /> Print Ops
        </Link>
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto pb-24 md:pb-8">
        <header className="px-4 pb-2 pt-4 md:px-8 md:pt-8">
          <h1 className="ops-page-title" data-testid="text-nerve-title">{current.label}</h1>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-[hsl(var(--text-2))]">Loads from the Mac mini over Tailscale; nothing is stored on Print Ops.</p>
        </header>
        <div className="px-4 md:px-8">{body}</div>
      </main>

      <nav aria-label="Nerve tabs" className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background md:hidden">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/nerve/${t.id}`}
            data-testid={`link-nerve-tab-${t.id}`}
            className={cn("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground", tab === t.id && "font-semibold text-foreground")}
          >
            <t.icon className="h-5 w-5" />
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
