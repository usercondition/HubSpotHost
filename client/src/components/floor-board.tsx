import { Link } from "wouter";
import { AlertTriangle, Beaker, Bell, ChevronRight, Clock3, FileUp, Link2, MapPin, Printer, Wallet } from "lucide-react";
import type { FloorNeed, FloorNeedIcon } from "@/lib/floor-needs";
import { formatMoney } from "@/lib/format";
import { stagePresentation } from "@/lib/stage-chip";
import { cn } from "@/lib/utils";
import { formatShipByShort } from "@shared/ship-by";
import { targetLabel, type StackView } from "@/components/priority-stack-list";
import { orderTitle } from "@/lib/order-title";
import type { PrinterUsageBreakdown, ResinReorderSuggestion } from "@shared/schema";

const ICONS: Record<FloorNeedIcon, typeof FileUp> = {
  file: FileUp,
  alert: AlertTriangle,
  link: Link2,
  beaker: Beaker,
  printer: Printer,
  pin: MapPin,
};

function wearPercent(printer: PrinterUsageBreakdown): number {
  return Math.max(printer.fepHoursUsedPercent ?? 0, printer.fepLayersUsedPercent ?? 0);
}

function needCaption(needs: FloorNeed[]): string {
  const orders = needs.filter((need) => need.dealId).length;
  const shop = needs.length - orders;
  const parts: string[] = [];
  if (orders > 0) parts.push(`${orders} ${orders === 1 ? "order" : "orders"}`);
  if (shop > 0) parts.push(`${shop} shop ${shop === 1 ? "task" : "tasks"}`);
  return parts.join(", ") || "Nothing waiting";
}

export function FloorBoard({
  needs,
  today,
  stack,
  inProduction,
  waitingToPrint,
  plateHours,
  printers,
  resin,
  intakeWaiting,
  buyerLinks,
  replies,
  syncIssues,
  onCopyChase,
}: {
  needs: FloorNeed[];
  today: string;
  stack: StackView | undefined;
  inProduction: number;
  waitingToPrint: number;
  plateHours: number;
  printers: PrinterUsageBreakdown[];
  resin: ResinReorderSuggestion | null;
  intakeWaiting: number;
  buyerLinks: number;
  replies: number;
  syncIssues: number;
  onCopyChase: (draft: string) => void;
}) {
  const due = (stack?.rows ?? []).filter((row) => row.targetDate === today);
  const dueFirst = due[0];
  const committed = stack?.totals.committed ?? 0;
  const offBook = stack?.totals.offBookUnpriced ?? 0;
  const ranked = printers
    .map((printer) => ({ printer, percent: wearPercent(printer) }))
    .sort((a, b) => b.percent - a.percent);
  const shown = ranked.slice(0, 5);
  const hiddenUnder = ranked.filter((row) => row.percent < 85).length - shown.filter((row) => row.percent < 85).length;
  const duePrinters = ranked.filter((row) => row.percent >= 85).length;
  const next = (stack?.rows ?? []).slice(0, 4);

  return (
    <div className="floor-page" data-testid="panel-todays-work">
      <div className="floor-kpis">
        <Kpi
          testId="kpi-needs-you"
          warn={needs.length > 0}
          icon={Bell}
          label="Needs you"
          value={String(needs.length)}
          detail={needCaption(needs)}
        />
        <Kpi
          testId="kpi-due-today"
          warn={due.length > 0}
          icon={Clock3}
          label="Due today"
          value={String(due.length)}
          detail={dueFirst ? `${dueFirst.name} · ${dueFirst.amount == null ? "—" : formatMoney(dueFirst.amount)}` : "None due today"}
        />
        <Kpi
          testId="kpi-cash-week"
          icon={Wallet}
          label="Cash this week"
          value={formatMoney(committed)}
          detail={
            offBook > 0
              ? `${nextCommittedCount(stack)} orders committed`
              : `${nextCommittedCount(stack)} orders committed`
          }
          extra={offBook > 0 ? `+${offBook} off-book, no amount` : undefined}
        />
        <Kpi
          testId="kpi-in-production"
          icon={Printer}
          label="In production"
          value={String(inProduction)}
          detail={`${plateHours}h of plates on printers`}
          extra={waitingToPrint > 0 ? `${waitingToPrint} waiting to print` : undefined}
        />
      </div>

      <div className="floor-columns">
        <div className="floor-col">
          <section className="ops-card" data-testid="panel-floor-needs">
            <div className="floor-card-head">
              <h2>
                Needs you <span className="nav-count nav-count-hot numeric">{needs.length}</span>
              </h2>
              <span className="hidden text-[12px] text-[hsl(var(--text-3))] md:inline">Overdue first, then by date</span>
            </div>
            {needs.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[hsl(var(--text-2))]" data-testid="empty-floor-needs">
                Nothing is waiting on you.
              </p>
            ) : (
              needs.map((need) => <NeedRow key={need.key} need={need} today={today} onCopyChase={onCopyChase} />)
            )}
          </section>

          <section className="ops-card" data-testid="panel-floor-up-next">
            <div className="floor-card-head">
              <h2>Up next on the Stack</h2>
              <Link href="/stack" className="text-[13px] font-medium text-primary" data-testid="link-floor-stack">
                Open
              </Link>
            </div>
            {stack ? (
              <p className="hidden px-4 pb-1 text-[12px] text-[hsl(var(--text-3))] md:block">
                {formatMoney(committed)} this week
                {offBook > 0 ? ` · +${offBook} off-book, no amount` : ""}
              </p>
            ) : null}
            {next.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[hsl(var(--text-2))]">The Stack is clear.</p>
            ) : (
              next.map((row) => {
                const stage = stagePresentation(row.stage);
                const date = targetLabel(row, today);
                const title = orderTitle(row.name, row.contactName);
                const contact = row.contactName?.trim();
                return (
                  <Link key={row.key} href="/stack" className="floor-next" data-testid={`row-floor-next-${row.rank}`}>
                    <span className="numeric text-[13px] text-[hsl(var(--text-3))]">{row.rank}</span>
                    <span className="floor-next-name min-w-0 text-[14px] font-semibold">
                      {title}
                      {contact && title.toLowerCase() !== contact.toLowerCase() ? (
                        <span className="floor-next-client font-normal text-[hsl(var(--text-2))]"> · {contact}</span>
                      ) : null}
                    </span>
                    <span className={cn("stage-chip", `stage-${stage.tone}`)} title={stage.label}>
                      <i />
                      <span className="max-md:hidden">{stage.label}</span>
                      <span className="md:hidden">{stage.short}</span>
                    </span>
                    <span className={cn("truncate text-[13px]", date.startsWith("Due today") && "font-semibold text-[hsl(var(--warn))]", date.startsWith("Overdue") && "text-[hsl(var(--bad))]")}>
                      {date}
                    </span>
                    <span className="numeric text-right text-[14px]">{row.amount == null ? "—" : formatMoney(row.amount)}</span>
                  </Link>
                );
              })
            )}
          </section>
        </div>

        <div className="floor-col">
          <section className="ops-card" data-testid="panel-floor-fep">
            <div className="floor-card-head">
              <h2>FEP film wear</h2>
              {duePrinters > 0 ? <span className="stage-chip stage-bad">{duePrinters} due</span> : null}
            </div>
            {shown.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[hsl(var(--text-2))]">No printers yet.</p>
            ) : (
              shown.map(({ printer, percent }) => {
                const over = percent >= 100;
                const mid = percent >= 85 && !over;
                return (
                  <div key={printer.printerId} className="floor-meter" data-testid={`row-fep-${printer.printerId}`}>
                    <span className="truncate text-[13px]">{printer.name}</span>
                    <span className={cn("floor-bar", over && "is-over", mid && "is-mid")}>
                      <i style={{ width: `${Math.min(100, percent)}%` }} />
                    </span>
                    <span className={cn("numeric text-right text-[13px]", over ? "text-[hsl(var(--bad))]" : "text-[hsl(var(--text-2))]")}>
                      {Math.round(percent)}%
                    </span>
                  </div>
                );
              })
            )}
            <Link href="/printers" className="floor-kv text-[12px] text-[hsl(var(--text-3))]" data-testid="link-floor-printers">
              <span>{Math.max(0, hiddenUnder)} more printers under 85%</span>
              <span>Printers</span>
            </Link>
          </section>

          <section className="ops-card" data-testid="panel-floor-health">
            <div className="floor-card-head">
              <h2>Shop health</h2>
            </div>
            <div className="floor-kv">
              <span>HubSpot sync</span>
              <span className={cn("stage-chip", syncIssues > 0 ? "stage-warn" : "stage-good")}>
                {syncIssues} {syncIssues === 1 ? "issue" : "issues"}
              </span>
            </div>
            <div className="floor-kv">
              <span className="truncate">Intake waiting / buyer links open</span>
              <span className="numeric text-[13px]">
                {intakeWaiting} / {buyerLinks}
              </span>
            </div>
            <div className="floor-kv">
              <span className="truncate">{resin?.name ?? "Resin stock"}</span>
              <span className="text-[13px] text-[hsl(var(--text-2))]">
                {resin ? `${resin.sealedCount} sealed · ${resin.urgency === "ok" ? "OK" : resin.urgency}` : "—"}
              </span>
            </div>
            <div className="floor-kv">
              <span>Waiting on a reply</span>
              <span className="numeric text-[13px]">{replies}</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function nextCommittedCount(stack: StackView | undefined): number {
  if (!stack) return 0;
  return stack.rows.filter((row) => row.tier === "committed" && !(row.kind === "offbook" && row.amount == null)).length;
}

function Kpi({
  testId,
  warn,
  icon: Icon,
  label,
  value,
  detail,
  extra,
}: {
  testId: string;
  warn?: boolean;
  icon: typeof Bell;
  label: string;
  value: string;
  detail: string;
  extra?: string;
}) {
  return (
    <article className={cn("ops-card floor-kpi", warn && "is-warn")} data-testid={testId}>
      <div className="flex items-center gap-1.5 text-[hsl(var(--text-3))]">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">{label}</span>
      </div>
      <p className="numeric mt-2 text-[26px] font-medium leading-8 tracking-tight max-md:text-[20px] max-md:leading-[26px]">{value}</p>
      <p className="mt-1 text-[12px] leading-4 text-[hsl(var(--text-2))]">{detail}</p>
      {extra ? <p className="text-[12px] leading-4 text-[hsl(var(--text-2))]">{extra}</p> : null}
    </article>
  );
}

function NeedRow({
  need,
  today,
  onCopyChase,
}: {
  need: FloorNeed;
  today: string;
  onCopyChase: (draft: string) => void;
}) {
  const Icon = ICONS[need.icon];
  const overdue = Boolean(need.shipBy && need.shipBy < today);
  const dueToday = need.shipBy === today;
  const date = !need.shipBy ? "" : overdue ? `Overdue ${formatShipByShort(need.shipBy)}` : dueToday ? "Due today" : formatShipByShort(need.shipBy);
  return (
    <article className="floor-need" data-testid={need.testId}>
      <span className={cn("floor-ico", need.lane === "shop" ? "is-shop" : "is-teal")}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[14px] font-semibold">{need.name}</p>
        <p className="truncate text-[12px] text-[hsl(var(--text-2))]">
          {date ? <span className="md:hidden">{date} · </span> : null}
          {need.problem}
        </p>
        {need.chaseDraft ? (
          <button type="button" className="mt-1 text-[13px] font-semibold text-primary" onClick={() => onCopyChase(need.chaseDraft!)}>
            Copy chase
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {date ? (
          <span className={cn("hidden text-[13px] md:inline", overdue && "text-[hsl(var(--bad))]", dueToday && "font-semibold text-[hsl(var(--warn))]")}>
            {date}
          </span>
        ) : null}
        {need.money ? <span className="numeric text-[14px]">{need.money}</span> : null}
        <Link href={need.href} className="floor-action hidden md:inline-flex" data-testid={need.dealId ? `link-glance-action-${need.dealId}` : undefined}>
          {need.pill}
        </Link>
        <Link href={need.href} aria-label={`Open ${need.name}`} className="text-[hsl(var(--text-3))]">
          <ChevronRight className="h-4 w-4" />
        </Link>
      </div>
    </article>
  );
}
