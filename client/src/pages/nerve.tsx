import { useQuery } from "@tanstack/react-query";
import { Link, Redirect, useRoute } from "wouter";
import { Activity, ArrowLeft, Bot, HeartPulse, LayoutDashboard, Radar } from "lucide-react";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { nerveGet } from "@/lib/nerve";
import type { NerveError, NerveModel, NerveTile } from "@/lib/nerve";
import { NerveErrorState, NerveUnlock, useNerveAccess } from "@/components/nerve-common";

type Tone = "neutral" | "good" | "bad";
const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
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
  const agents = m.agents.filter((a) => !a.planned);
  const live = agents.filter((a) => a.status === "running").length;
  const paused = agents.filter((a) => a.paused_at).length;
  const day = Date.now() - 86_400_000;
  const runs24 = (m.runs ?? []).filter((r) => Date.parse(r.created_at) > day);
  const failed = runs24.filter((r) => r.status === "failed" || r.status === "error" || (r.error_code && r.status !== "cancelled")).length;
  const tiles = m.glance.sections.flatMap((s) => s.tiles);
  const xai = tiles.find((t) => t.id === "xai");
  const spend = tiles.find((t) => t.id === "spend");
  const health = m.glance.sections.find((s) => s.id === "health")?.tiles ?? [];
  const svcRed = m.services.filter((s) => toneOf(s.state) === "bad").length;
  const allClear = v.systemRed.length === 0;
  const needs = (m.needs ?? []).slice(0, 6);
  return (
    <div className="space-y-4">
      <div
        className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3", allClear ? "border-good/30 bg-good/5" : "border-bad/30 bg-bad/5")}
        data-testid="nerve-verdict"
      >
        <Dot tone={allClear ? "good" : "bad"} />
        <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          {allClear ? "All systems normal" : `${v.systemRed.length} system check${v.systemRed.length === 1 ? "" : "s"} red: ${v.systemRed.join(", ")}`}
        </p>
        <span className="text-xs text-muted-foreground">
          {m.refresh ? `data ${Math.round(m.refresh.dataAgeMs / 60000)}m old` : ""}
          {m.at ? ` · updated ${ago(m.at)}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Agents" value={`${live} live`} hint={`${agents.length} total · ${paused} paused`} icon={Bot} tone="neutral" testId="stat-nerve-agents" />
        <StatCard label="Runs (24h)" value={`${runs24.length}${runs24.length >= (m.runs ?? []).length && runs24.length >= 30 ? "+" : ""}`} hint={failed ? `${failed} failed` : "No failures"} icon={Activity} tone={failed ? "bad" : "good"} testId="stat-nerve-runs" />
        <StatCard label="Services" value={`${m.services.length - svcRed} / ${m.services.length} ok`} hint={svcRed ? `${svcRed} red` : "Mac mini + launchd"} icon={HeartPulse} tone={svcRed ? "bad" : "good"} testId="stat-nerve-services" />
        <StatCard label="Hermes / xAI today" value={xai?.value ?? "—"} hint={spend?.value ? `Agents: ${spend.value}` : "xAI watch"} icon={Radar} tone="neutral" testId="stat-nerve-xai" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Needs you" description={`${v.needs} open`} testId="panel-nerve-needs">
          {needs.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting.</p> : null}
          {needs.map((n, i) => (
            <div key={i} className="flex items-start gap-2 border-b border-border/50 py-2 last:border-0">
              <span className="mt-1.5"><Dot tone={n.st === "red" ? "bad" : "neutral"} /></span>
              <p className="min-w-0 text-sm text-foreground" data-private="text">{n.t}</p>
            </div>
          ))}
        </Panel>
        <Panel title="Health" description="Mac mini checks" testId="panel-nerve-health-tiles">
          <div className="grid grid-cols-2 gap-2">
            {health.map((t) => (
              <div key={t.id} className="rounded-md border border-border/60 px-2.5 py-2" data-testid={`tile-nerve-${t.id}`}>
                <div className="flex items-center gap-1.5">
                  <Dot tone={toneOf(t.state)} />
                  <p className="truncate text-xs font-medium text-foreground">{t.title}</p>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{t.value || t.state}</p>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Recent runs" description="Paperclip, newest first" testId="panel-nerve-recent-runs">
          {(m.runs ?? []).slice(0, 8).map((r) => (
            <div key={r.id} className="flex items-center gap-2 border-b border-border/50 py-1.5 last:border-0">
              <Dot tone={r.error_code && r.status !== "cancelled" ? "bad" : toneOf(r.status)} />
              <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                <span className="font-medium">{r.agent}</span>
                <span className="text-muted-foreground">{r.issue ? ` · ${r.issue}` : ""}</span>
              </p>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{[dur(r.started_at || r.created_at, r.finished_at), ago(r.finished_at || r.created_at)].filter(Boolean).join(" · ")}</span>
            </div>
          ))}
        </Panel>
      </div>
      <Panel title="Agents" description="Status, model and budget use" testId="panel-nerve-agent-grid">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a, i) => (
            <div key={`${a.name}-${i}`} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                  <Dot tone={a.paused_at ? "neutral" : a.status === "error" ? "bad" : "good"} />
                  {a.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">{[a.paused_at ? "paused" : a.status, a.model].filter(Boolean).join(" · ")}</p>
              </div>
              <BudgetBar spent={a.s} budget={a.b} />
            </div>
          ))}
        </div>
      </Panel>
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


const ago = (iso?: string | null) => {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return Number.isFinite(s) ? age(Math.max(0, s)) : "";
};
const dur = (a?: string | null, b?: string | null) => {
  const ms = (Date.parse(b || "") || Date.now()) - (Date.parse(a || "") || NaN);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};
const usd = (cents?: number) => (cents == null ? "" : `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`);

function Dot({ tone }: { tone: Tone }) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", tone === "good" ? "bg-good" : tone === "bad" ? "bg-bad" : "bg-[hsl(var(--text-3))]")} aria-hidden />;
}

function BudgetBar({ spent, budget }: { spent?: number; budget?: number }) {
  if (!budget) return <span className="text-xs text-muted-foreground">no cap</span>;
  const pct = Math.min(100, Math.round(((spent ?? 0) / budget) * 100));
  return (
    <span className="flex min-w-0 items-center gap-2" title={`${usd(spent ?? 0)} of ${usd(budget)}`}>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", pct >= 90 ? "bg-bad" : "bg-good")} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">{usd(spent ?? 0)} / {usd(budget)}</span>
    </span>
  );
}

function Agents({ m }: { m: NerveModel }) {
  const runs = (m.runs ?? []).slice(0, 15);
  const issues = (m.issues ?? []).slice(0, 15);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Agents" description="Paperclip roster" testId="panel-nerve-agents">
        {m.agents.map((a, i) => (
          <div key={`${a.name}-${i}`} className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{a.name}</p>
              <p className="truncate text-xs text-muted-foreground">{[a.role, a.model, a.last_heartbeat_at ? `seen ${ago(a.last_heartbeat_at)}` : ""].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="max-sm:hidden"><BudgetBar spent={a.s} budget={a.b} /></span>
              <StatusPill tone={a.paused_at ? "neutral" : toneOf(a.status)} label={a.paused_at ? "paused" : a.status} />
            </div>
          </div>
        ))}
      </Panel>
      <Panel title="Recent runs" description="Newest first" testId="panel-nerve-runs">
        {runs.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{[r.agent, r.issue].filter(Boolean).join(" · ")}</p>
              <p className="truncate text-xs text-muted-foreground">{[r.title, dur(r.started_at || r.created_at, r.finished_at), ago(r.finished_at || r.created_at)].filter(Boolean).join(" · ")}</p>
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
  const key = useNerveAccess();
  const q = useQuery<NerveModel, NerveError>({
    queryKey: ["nerve", "/api/v3", key],
    queryFn: () => nerveGet<NerveModel>("/api/v3", key),
    enabled: !!key,
    refetchInterval: 60_000,
    retry: false,
  });

  const body =
    !key ? (
      <NerveUnlock />
    ) : q.isLoading ? (
      <Skeleton className="h-64 w-full" />
    ) : q.error ? (
      <NerveErrorState err={q.error} retry={() => q.refetch()} />
    ) : q.data ? (
      tab === "health" ? <Health m={q.data} /> : tab === "agents" ? <Agents m={q.data} /> : <Overview m={q.data} />
    ) : null;
  const current = TABS.find((t) => t.id === tab)!;
  // Chats moved to the Print Ops Inbox; keep old /nerve/chat links working.
  if (params?.tab === "chat") return <Redirect to="/inbox?tab=chats" />;

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
            <span className="block truncate text-[11px] text-[hsl(var(--text-3))]">System · read-only</span>
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
          <p className="mt-1 max-w-3xl text-sm leading-5 text-[hsl(var(--text-2))]">Loads from the Mac mini over Tailscale, read-only. Unlocks with your Print Ops key.</p>
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
