import { Link } from "wouter";
import { Scale, TrendingDown, TrendingUp } from "lucide-react";
import { Panel, StatusPill } from "@/components/primitives";
import type { SupplyBooksBalance } from "@shared/schema";

function money(value: number | string): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  return (Number.isFinite(parsed) ? parsed : 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function percent(value: number): string {
  return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
}

function rowTone(value: number): "good" | "bad" | "neutral" {
  if (value > 0.005) return "good";
  if (value < -0.005) return "bad";
  return "neutral";
}

export function BooksBalancePanel({
  books,
  showSuppliesLink = false,
}: {
  books: SupplyBooksBalance;
  showSuppliesLink?: boolean;
}) {
  const maxBar = Math.max(books.revenue, books.supplySpend, 1);

  return (
    <Panel
      title="Books balance"
      description={`Last ${books.periodDays} days — order revenue and profit set against logged supply purchases.`}
      actions={
        showSuppliesLink ? (
          <Link href="/supplies" className="text-xs font-medium text-primary hover:underline" data-testid="link-books-supplies">
            Log a purchase
          </Link>
        ) : undefined
      }
    >
      <div className="space-y-4" data-testid="panel-books-balance">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Scale className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium">Where the money went</p>
          </div>
          <StatusPill
            tone={rowTone(books.afterSupplySpend)}
            icon={books.afterSupplySpend >= 0 ? TrendingUp : TrendingDown}
            label={`${money(books.afterSupplySpend)} after supplies`}
            testId="status-books-after-supplies"
          />
        </div>

        <dl className="space-y-2">
          <BooksRow
            label="Revenue"
            hint={`${books.orders} Print Order${books.orders === 1 ? "" : "s"} created`}
            value={books.revenue}
            bar={books.revenue / maxBar}
            emphasize
            testId="books-revenue"
          />
          <BooksRow
            label="− Order costs"
            hint="Material, labor, packaging, and shipping on HubSpot deals"
            value={-books.orderCosts}
            bar={books.orderCosts / maxBar}
            muted
            testId="books-order-costs"
          />
          <BooksRow
            label="= Gross profit"
            hint="What each order kept after its own actual costs"
            value={books.grossProfit}
            bar={Math.abs(books.grossProfit) / maxBar}
            emphasize
            testId="books-gross-profit"
          />
          <BooksRow
            label="− Supply spend"
            hint={`${books.supplyPurchases} receipt${books.supplyPurchases === 1 ? "" : "s"} logged in Supply Spend`}
            value={-books.supplySpend}
            bar={books.supplySpend / maxBar}
            muted
            testId="books-supply-spend"
          />
          <BooksRow
            label="= After supply spend"
            hint={
              books.revenue > 0
                ? `Supplies are ${percent(books.supplyShareOfRevenuePercent)} of revenue`
                : "Log orders and receipts to compare"
            }
            value={books.afterSupplySpend}
            bar={Math.abs(books.afterSupplySpend) / maxBar}
            emphasize
            testId="books-after-supplies"
          />
        </dl>

        {books.byCategory.length > 0 ? (
          <div className="space-y-2" data-testid="books-supply-categories">
            <p className="text-xs font-medium text-muted-foreground">Supply spend by category</p>
            {books.byCategory.map((bucket) => (
              <div
                key={bucket.category}
                className="flex items-center justify-between gap-3 rounded-md bg-muted/45 px-3 py-2"
                data-testid={`row-books-category-${bucket.category}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{bucket.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {bucket.count} line{bucket.count === 1 ? "" : "s"} · {percent(bucket.shareOfSupplyPercent)} of supplies
                  </p>
                </div>
                <span className="numeric shrink-0 text-sm font-medium">{money(bucket.total)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md bg-muted/45 p-3" data-testid="empty-books-categories">
            <p className="text-sm font-medium">No supply receipts in this window yet.</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Log resin, gloves, packaging, and maintenance purchases to see how overhead sits against order profit.
            </p>
          </div>
        )}

        <p className="text-xs leading-5 text-muted-foreground" data-testid="note-books-disclaimer">
          After supply spend is a management check, not net profit. If you also enter the same resin or packaging as an
          actual cost on a HubSpot deal, that spend can appear in both order costs and supply spend.
        </p>
      </div>
    </Panel>
  );
}

function BooksRow({
  label,
  hint,
  value,
  bar,
  emphasize = false,
  muted = false,
  testId,
}: {
  label: string;
  hint: string;
  value: number;
  bar: number;
  emphasize?: boolean;
  muted?: boolean;
  testId: string;
}) {
  const width = `${Math.max(4, Math.min(100, Math.round(Math.abs(bar) * 100)))}%`;
  return (
    <div className="rounded-md border border-border/70 bg-card/40 px-3 py-2.5" data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <dt className={`text-sm ${emphasize ? "font-semibold" : "font-medium"}`}>{label}</dt>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p>
        </div>
        <dd
          className={`numeric shrink-0 text-sm ${
            emphasize ? "font-semibold" : "font-medium"
          } ${muted ? "text-muted-foreground" : value < 0 ? "text-destructive" : ""}`}
        >
          {money(value)}
        </dd>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${muted ? "bg-muted-foreground/40" : "bg-primary"}`}
          style={{ width }}
        />
      </div>
    </div>
  );
}
