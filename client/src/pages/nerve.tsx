import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useRoute } from "wouter";
import { Activity, ArrowLeft, Bot, HeartPulse, LayoutDashboard, Lock, MessagesSquare, Radar, RefreshCw, WifiOff } from "lucide-react";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getNerveKey, nerveGet, onNerveKeyChange, setNerveKey } from "@/lib/nerve";
import type { NerveError, NerveModel, NerveThread, NerveThreadList, NerveTile } from "@/lib/nerve";

type Tone = "neutral" | "good" | "bad";
const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "chat", label: "Chat", icon: MessagesSquare },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "health", label: "Health", icon: HeartPulse },
] as const;
type TabId = (typeof TABS)[number]["id"];

const toneOf = (s: string | undefined): Tone => {
  const v = String(s || "").toLowerCase();
  if (["ok", "up", "green", "running", "idle", "good", "succeeded", "done"].includes(v)) return "good";
  if (["red", "down", "bad", "error", "failed"].includes(v)) return "bad";
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
        <StatusPill tone={err.kind === "offline" ? "neutral" : "bad"} icon={WifiOff} label={err.kind === "offline" ? "Off tailnet" : "Error"} />
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
        <StatCard label="Stale / unknown" value={`${v.stale.length} / ${v.unknown.length}`} hint={[...v.stale, ...v.unknown].join(", ") || "Fresh"} icon={HeartPulse} tone="neutral" testId="stat-nerve-stale" />
        <StatCard label="Needs you" value={String(v.needs)} hint="Open items on the Nerve board" icon={LayoutDashboard} tone="neutral" testId="stat-nerve-needs" />
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


const V3_URL = "https://miguels-mac-mini.tailc0d52c.ts.net/nerve/";
const ago = (iso?: string | null) => {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return Number.isFinite(s) ? age(Math.max(0, s)) : "";
};

function Chat() {
  const [, navigate] = useLocation();
  const [, cp] = useRoute<{ uid: string }>("/nerve/chat/:uid");
  const uid = cp?.uid ? decodeURIComponent(cp.uid) : null;
  const key = useNerveKey();
  const list = useQuery<NerveThreadList, NerveError>({
    queryKey: ["nerve", "/api/messages", key],
    queryFn: () => nerveGet<NerveThreadList>("/api/messages"),
    enabled: !!key,
    refetchInterval: 60_000,
    retry: false,
  });
  const thread = useQuery<NerveThread, NerveError>({
    queryKey: ["nerve", "/api/messages/thread", uid, key],
    queryFn: () => nerveGet<NerveThread>(`/api/messages/thread?uid=${encodeURIComponent(uid || "")}&limit=40`),
    enabled: !!key && !!uid,
    retry: false,
  });
  if (!key) return <Unlock />;
  if (list.isLoading) return <Skeleton className="h-64 w-full" />;
  if (list.error) return <ErrorState err={list.error} retry={() => list.refetch()} />;
  const threads = (list.data?.threads ?? []).filter((t) => !t.archived && !t.deleted);
  const open = (id: string) => navigate(`/nerve/chat/${encodeURIComponent(id)}`);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Panel
        title="FB Marketplace inbox"
        description={`${threads.filter((t) => t.owes).length} owe a reply · read-only`}
        testId="panel-nerve-threads"
        className={cn(uid && "max-lg:hidden")}
      >
        {threads.length === 0 ? <p className="text-sm text-muted-foreground">No open threads.</p> : null}
        {threads.map((t) => (
          <button
            key={t.uid}
            type="button"
            onClick={() => open(t.uid)}
            data-testid={`row-nerve-thread-${t.uid}`}
            className={cn(
              "flex w-full items-start justify-between gap-3 border-b border-border/50 py-2 text-left last:border-0 hover:bg-muted/50",
              uid === t.uid && "bg-muted",
            )}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground" data-private="name">{t.name}</p>
              <p className="truncate text-xs text-muted-foreground" data-private="text">{t.listing}</p>
              <p className="truncate text-xs text-[hsl(var(--text-3))]" data-private="text">{t.last}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-[11px] text-[hsl(var(--text-3))]">{t.when}</span>
              {t.owes ? <StatusPill tone="bad" label="Owes reply" /> : null}
            </div>
          </button>
        ))}
      </Panel>
      <div className={cn(!uid && "max-lg:hidden")}>
        {!uid ? (
          <Panel title="Pick a thread" description="Replies, archive and delete stay in Nerve v3 for now." testId="panel-nerve-thread-empty">
            <a className="text-sm underline" href={V3_URL} target="_blank" rel="noopener noreferrer">Open Nerve v3</a>
          </Panel>
        ) : thread.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : thread.error ? (
          <ErrorState err={thread.error} retry={() => thread.refetch()} />
        ) : thread.data ? (
          <Panel
            title={thread.data.name}
            description={[thread.data.listing, thread.data.stage].filter(Boolean).join(" · ")}
            testId="panel-nerve-thread"
            actions={
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="lg:hidden" onClick={() => navigate("/nerve/chat")} data-testid="button-nerve-thread-back">
                  <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Threads
                </Button>
                <a className="inline-flex h-8 items-center rounded-md border border-border px-2 text-sm hover:bg-muted" href={V3_URL} target="_blank" rel="noopener noreferrer" data-testid="link-nerve-reply-v3">
                  Reply in Nerve v3
                </a>
              </div>
            }
          >
            {thread.data.summary ? <p className="mb-3 text-sm text-muted-foreground" data-private="text">{thread.data.summary}</p> : null}
            <div className="flex flex-col gap-2" data-testid="list-nerve-messages">
              {thread.data.messages.map((m, i) =>
                m.divider && !m.text ? (
                  <p key={m.id || i} className="py-1 text-center text-[11px] text-[hsl(var(--text-3))]">{m.dividerLabel || m.when}</p>
                ) : (
                  <div key={m.id || i} className={cn("flex", m.who === "me" ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[80%] whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm",
                        m.who === "me" ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-muted text-foreground",
                      )}
                    >
                      <span data-private="text">{m.text}</span>
                      <span className="mt-1 block text-[10px] opacity-70">{m.when}</span>
                    </div>
                  </div>
                ),
              )}
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

function Agents({ m }: { m: NerveModel }) {
  const runs = (m.runs ?? []).slice(0, 15);
  const issues = (m.issues ?? []).slice(0, 15);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Agents" description="Paperclip roster" testId="panel-nerve-agents">
        {m.agents.map((a) => (
          <div key={a.name} className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{a.name}</p>
              <p className="truncate text-xs text-muted-foreground">{[a.role, a.last_heartbeat_at ? `seen ${ago(a.last_heartbeat_at)}` : ""].filter(Boolean).join(" · ")}</p>
            </div>
            <StatusPill tone={a.paused_at ? "neutral" : toneOf(a.status)} label={a.paused_at ? "paused" : a.status} />
          </div>
        ))}
      </Panel>
      <Panel title="Recent runs" description="Newest first" testId="panel-nerve-runs">
        {runs.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{[r.agent, r.issue].filter(Boolean).join(" · ")}</p>
              <p className="truncate text-xs text-muted-foreground">{[r.title, ago(r.finished_at || r.created_at)].filter(Boolean).join(" · ")}</p>
            </div>
            <StatusPill tone={r.error_code ? "bad" : toneOf(r.status)} label={r.status} />
          </div>
        ))}
      </Panel>
      <Panel title="Open issues" description="Paperclip board" testId="panel-nerve-issues" className="lg:col-span-2">
        {issues.map((i) => (
          <div key={i.identifier} className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{i.identifier} · {i.title}</p>
              <p className="truncate text-xs text-muted-foreground">{[i.agent, ago(i.updated_at)].filter(Boolean).join(" · ")}</p>
            </div>
            <StatusPill tone="neutral" label={i.status.replace(/_/g, " ")} />
          </div>
        ))}
      </Panel>
    </div>
  );
}

export default function NervePage() {
  const [, p1] = useRoute<{ tab: string }>("/nerve/:tab");
  const [, p2] = useRoute<{ tab: string; sub: string }>("/nerve/:tab/:sub");
  const params = p2 ?? p1;
  const tab: TabId = (TABS.find((t) => t.id === params?.tab)?.id ?? "overview") as TabId;
  const key = useNerveKey();
  const q = useQuery<NerveModel, NerveError>({
    queryKey: ["nerve", "/api/v3", key],
    queryFn: () => nerveGet<NerveModel>("/api/v3"),
    enabled: !!key && (tab === "overview" || tab === "health" || tab === "agents"),
    refetchInterval: 60_000,
    retry: false,
  });

  const body =
    tab === "chat" ? (
      <Chat />
    ) : !key ? (
      <Unlock />
    ) : q.isLoading ? (
      <Skeleton className="h-64 w-full" />
    ) : q.error ? (
      <ErrorState err={q.error} retry={() => q.refetch()} />
    ) : q.data ? (
      tab === "health" ? <Health m={q.data} /> : tab === "agents" ? <Agents m={q.data} /> : <Overview m={q.data} />
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
