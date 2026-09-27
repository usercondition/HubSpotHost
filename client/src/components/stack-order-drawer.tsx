/**
 * Stack order drawer. Slides in from the right on desktop and up from the
 * bottom on a phone. Queue and Orders keep the separate deal-ops editor.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ExternalLink, X } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { OrderUpdates } from "@/components/order-updates";
import { SliceFiles } from "@/components/slice-files";
import { targetLabel, type StackRowModel } from "@/components/priority-stack-list";
import { formatMoney } from "@/lib/format";
import { orderTitle } from "@/lib/order-title";
import { libraryKitName } from "@shared/plate-files";
import { drawerPanelVariants, drawerScrimVariants, drawerTransition } from "@/lib/motion";
import { apiRequest } from "@/lib/queryClient";
import { hubspotDealHref, labelsDealHref, printsDealHref } from "@/lib/workflow";

type DrawerOps = {
  shipPlanNote?: string | null;
  hubspotPortalId?: string | null;
  plates?: Array<{ id: number; fileName: string }>;
  checklist?: { trackingNumber?: string; labelBought?: boolean };
};

const FOCUSABLE = "a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex='-1'])";

const sheetVariants = {
  initial: { y: "100%" },
  enter: { y: 0, transition: drawerTransition },
  exit: { y: "100%", transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number] } },
};

const stillVariants = {
  initial: { opacity: 1, x: 0, y: 0 },
  enter: { opacity: 1, x: 0, y: 0 },
  exit: { opacity: 1, x: 0, y: 0 },
};

function useDesktopDrawer(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : false,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return desktop;
}

function floorStatus(row: StackRowModel): string {
  const named: Record<string, string> = {
    next_print: "Next print",
    in_production: "In production",
    ship_ready: "Ship ready",
    blocked: "Blocked",
  };
  const floor = named[row.bucket] ?? row.stage;
  if (row.fulfillment) return `${floor} · ${row.fulfillment.completedCount}/${row.fulfillment.totalCount}`;
  if (row.kind === "offbook" && row.steps.length > 0) {
    const done = row.steps.filter((step) => step.done).length;
    return `${row.stage} · ${done}/${row.steps.length}`;
  }
  return floor || "None";
}

function shipByLabel(row: StackRowModel, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.targetDate)) return "None";
  return targetLabel(row, today);
}

function Fact({ label, children, testId }: { label: string; children: string; testId: string }) {
  return (
    <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-2 border-b border-border/70 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

export function StackOrderDrawer({
  row,
  today,
  bundleName,
  headers,
  onClose,
}: {
  row: StackRowModel | null;
  today: string;
  bundleName: string | null;
  headers: Record<string, string>;
  onClose: () => void;
}) {
  const open = row != null;
  const desktop = useDesktopDrawer();
  const reduceMotion = useReducedMotion();
  const panelRef = useRef<HTMLElement | null>(null);
  const dealId = row?.kind === "deal" ? row.dealId : null;
  const ops = useQuery({
    queryKey: ["/api/deal-ops", dealId],
    enabled: open && Boolean(dealId),
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/deal-ops/${encodeURIComponent(dealId || "")}`, undefined, { headers });
      return (await response.json()) as DrawerOps;
    },
  });

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previously = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusables = () => [...(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const frame = window.requestAnimationFrame(() => {
      (panel?.querySelector<HTMLElement>("[data-testid='button-close-deal-ops-drawer']") ?? focusables()[0])?.focus({ preventScroll: true });
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      previously?.focus({ preventScroll: true });
    };
  }, [open, row?.key]);

  const drawer = (
    <AnimatePresence>
      {open && row ? (
        <motion.div
          key="stack-order-drawer"
          className="pointer-events-none fixed inset-0 z-[80]"
          data-testid="drawer-deal-ops-root"
          initial="initial"
          animate="enter"
          exit="exit"
        >
          <motion.button
            type="button"
            tabIndex={-1}
            aria-label="Dismiss order"
            className="pointer-events-auto absolute inset-0 bg-black/40 md:bg-black/25"
            onClick={onClose}
            data-testid="button-deal-ops-scrim"
            variants={reduceMotion ? undefined : drawerScrimVariants}
            initial={reduceMotion ? false : "initial"}
            animate={reduceMotion ? undefined : "enter"}
            exit={reduceMotion ? undefined : "exit"}
          />
          <motion.aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="stack-drawer-title"
            tabIndex={-1}
            className="stack-order-drawer pointer-events-auto"
            data-testid="drawer-deal-ops"
            onClick={(event) => event.stopPropagation()}
            variants={reduceMotion ? stillVariants : desktop ? drawerPanelVariants : sheetVariants}
            initial={reduceMotion ? false : "initial"}
            animate={reduceMotion ? undefined : "enter"}
            exit={reduceMotion ? undefined : "exit"}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5">
              <p className="rule-label">{row.kind === "offbook" ? "Off-book" : "Order"}</p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={onClose}
                data-testid="button-close-deal-ops-drawer"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4">
              <h2 id="stack-drawer-title" className="text-lg font-semibold tracking-tight">
                {orderTitle(row.name, row.contactName)}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                <span data-testid="drawer-customer">{row.contactName?.trim() || "No customer"}</span>
                {" · "}
                <span data-testid="drawer-amount">{row.amount == null ? "No amount" : formatMoney(row.amount)}</span>
                {" · "}
                <span data-testid="drawer-stage">{row.kind === "offbook" ? "Off-book" : row.stage || "No stage"}</span>
              </p>
              <SliceFiles
                orderKey={row.kind === "offbook" && row.offbookId ? `offbook:${row.offbookId}` : `deal:${row.dealId}`}
                kit={libraryKitName(row.name, row.contactName)}
                customer={row.contactName?.trim() || ""}
                headers={headers}
              />
              <div className="mt-3">
                <OrderUpdates
                  orderKey={row.kind === "offbook" && row.offbookId ? `offbook:${row.offbookId}` : `deal:${row.dealId}`}
                  headers={headers}
                />
              </div>
              <dl className="mt-3">
                <Fact label="Floor" testId="text-drawer-floor">{floorStatus(row)}</Fact>
                <Fact label="Ship by" testId="drawer-ship-by">{shipByLabel(row, today)}</Fact>
                <Fact label="Plan note" testId="drawer-plan-note">{ops.data?.shipPlanNote?.trim() || "None"}</Fact>
                <Fact label="Blocker" testId="drawer-blocker">{row.blocker.trim() || "None"}</Fact>
                <Fact label="Bundle" testId="drawer-bundle">{bundleName?.trim() || "None"}</Fact>
                <Fact label="Plates" testId="drawer-plates">
                  {row.kind === "offbook"
                    ? "None"
                    : (ops.data?.plates?.map((plate) => plate.fileName).filter(Boolean).join(", ") || "None")}
                </Fact>
                <Fact label="Tracking" testId="drawer-tracking">
                  {(row.fulfillment?.trackingNumber || ops.data?.checklist?.trackingNumber || "").trim()
                    || (row.fulfillment?.labelBought || ops.data?.checklist?.labelBought ? "Label bought" : "None")}
                </Fact>
              </dl>
              {row.kind === "deal" && row.dealId ? (
                <div className="mt-3 flex flex-wrap gap-2" data-testid="drawer-links">
                  <Button asChild size="sm" variant="outline">
                    <a href={hubspotDealHref(row.dealId, ops.data?.hubspotPortalId)} target="_blank" rel="noopener noreferrer">
                      HubSpot
                      <ExternalLink className="ml-2 h-3.5 w-3.5" />
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href={labelsDealHref(row.dealId)}>Labels</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href={printsDealHref(row.dealId)}>Prints</Link>
                  </Button>
                </div>
              ) : null}
            </div>
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  if (typeof document === "undefined") return drawer;
  return createPortal(drawer, document.body);
}
