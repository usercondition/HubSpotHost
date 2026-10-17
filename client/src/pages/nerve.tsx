import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { Activity, Bot, HeartPulse, LayoutDashboard, Lock, MessagesSquare, RefreshCw, WifiOff } from "lucide-react";
import { PageHeader } from "@/components/shell";
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

  return (
    <div className="pb-24">
      <PageHeader title="Nerve" subtitle="Mac mini system view, read-only. Loads from the Mac mini over Tailscale; nothing is stored on Print Ops." />
      <div className="px-4 md:px-8">
        <nav aria-label="Nerve sections" className="mb-4 flex flex-wrap gap-1 border-b border-border/60 pb-2" data-testid="nav-nerve-sub">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={`/nerve/${t.id}`}
              data-testid={`link-nerve-${t.id}`}
              aria-current={tab === t.id ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                tab === t.id && "bg-muted font-semibold text-foreground",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </Link>
          ))}
        </nav>
        {tab === "chat" ? (
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
        ) : null}
      </div>
    </div>
  );
}
