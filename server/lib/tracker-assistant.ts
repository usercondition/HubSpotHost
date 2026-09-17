/**
 * Read-only tracker assistant for the owner hub.
 *
 * Builds answers from the live Performance snapshot, intake queue, and
 * production-queue buckets (next print / ship-ready / labels gaps).
 * Never writes to HubSpot. Optional OpenAI-compatible model (OpenAI or xAI/Grok)
 * when a key is set; otherwise a deterministic intent engine answers from
 * structured data.
 */

import type {
  PerformanceResponse,
  OrderIntakeLink,
  ProductionQueueItem,
  ProductionQueueResponse,
} from "../../shared/schema";
import { ORDER_INTAKE_STATUS_LABELS } from "../../shared/schema";
import { groupShipByAgenda, shipByCalendarDate, shipByHonestyLabel } from "../../shared/ship-by";

export type TrackerAssistantMode = "rules" | "model";

export type TrackerAssistantAction = {
  label: string;
  href: string;
  external?: boolean;
};

export type TrackerAssistantAnswer = {
  ok: true;
  mode: TrackerAssistantMode;
  reply: string;
  actions: TrackerAssistantAction[];
  usedFacts: string[];
};

/** Slim production-queue row for rules + model context (no HubSpot writes). */
export type TrackerAssistantQueueDeal = {
  dealId: string;
  dealName: string;
  stage: string;
  amount: number;
  bucket: ProductionQueueItem["bucket"];
  costsIncomplete: boolean;
  hasPlates: boolean;
  labelBought: boolean;
  trackingPasted: boolean;
  shipReady: boolean;
  needsReply?: boolean;
  readyToPack?: boolean;
  /** Projected or override ship-by (`YYYY-MM-DD`, America/Los_Angeles). */
  shipBy?: string;
  shipBySource?: "override" | "derived";
  shipByReason?: string;
  addressStatus?: ProductionQueueItem["addressStatus"];
  addressSummary?: string | null;
  chaseDraft?: string;
};

export type TrackerAssistantShipAgenda = {
  today: string;
  overdue: TrackerAssistantQueueDeal[];
  dueToday: TrackerAssistantQueueDeal[];
  thisWeek: TrackerAssistantQueueDeal[];
};

export type TrackerAssistantQueueContext = {
  summary: ProductionQueueResponse["summary"];
  nextPrint: TrackerAssistantQueueDeal[];
  shipReady: TrackerAssistantQueueDeal[];
  blocked: TrackerAssistantQueueDeal[];
  /** Buyer conversations marked in HubSpot as waiting on the shop. */
  needsReply: TrackerAssistantQueueDeal[];
  /** Finished jobs waiting on packing, a label, or tracking. */
  readyToPack: TrackerAssistantQueueDeal[];
  /** Ship-ready (or nearly) without a bought label / tracking yet. */
  needsLabel: TrackerAssistantQueueDeal[];
  /** Ready to ship but HubSpot ship-to is missing or partial. */
  needsAddress: TrackerAssistantQueueDeal[];
  /** Floor honesty calendar: overdue / due today / next 7 days. */
  shipAgenda?: TrackerAssistantShipAgenda;
};

export type TrackerAssistantContext = {
  snapshot: PerformanceResponse;
  awaitingLinks: Array<Pick<OrderIntakeLink, "id" | "internalLabel" | "itemDescription" | "agreedAmount" | "expiresAt" | "status">>;
  pendingLinks: Array<Pick<OrderIntakeLink, "id" | "internalLabel" | "itemDescription" | "agreedAmount" | "clientFullName" | "status">>;
  queue?: TrackerAssistantQueueContext;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function printsHref(dealId: string): string {
  return `/prints?dealId=${encodeURIComponent(dealId)}`;
}

function queueHref(dealId: string): string {
  return `/queue?dealId=${encodeURIComponent(dealId)}`;
}

function labelsHref(dealId?: string): string {
  return dealId ? `/labels?dealId=${encodeURIComponent(dealId)}` : "/labels";
}

export function slimQueueDeal(item: ProductionQueueItem): TrackerAssistantQueueDeal {
  return {
    dealId: item.dealId,
    dealName: item.dealName,
    stage: item.stage,
    amount: item.amount,
    bucket: item.bucket,
    costsIncomplete: item.costsIncomplete,
    hasPlates: item.hasPlates,
    labelBought: item.fulfillment.labelBought,
    trackingPasted: item.fulfillment.trackingPasted,
    shipReady: item.fulfillment.shipReady || item.bucket === "ship_ready",
    needsReply: item.needsReply,
    readyToPack: item.readyToPack,
    shipBy: item.shipBy,
    shipBySource: item.shipBySource,
    shipByReason: item.shipByReason,
    addressStatus: item.addressStatus,
    addressSummary: item.addressSummary,
    chaseDraft: item.chaseDraft,
  };
}

/** Build assistant queue slice from a live production-queue response. */
export function buildTrackerAssistantQueue(queue: ProductionQueueResponse): TrackerAssistantQueueContext {
  const needsLabelSource = [...queue.shipReady, ...queue.inProduction].filter(
    (item) =>
      (item.bucket === "ship_ready" || item.fulfillment.shipReady || item.fulfillment.readyPercent >= 80) &&
      (!item.fulfillment.labelBought || !item.fulfillment.trackingPasted),
  );
  const needsAddressSource = [...queue.shipReady, ...queue.readyToPack, ...queue.inProduction].filter(
    (item) =>
      (item.bucket === "ship_ready" || item.readyToPack || item.fulfillment.readyPercent >= 80) &&
      item.addressStatus !== "ready",
  );
  const openJobs = [
    ...queue.nextPrint,
    ...queue.inProduction,
    ...queue.blocked,
    ...queue.shipReady,
  ].map(slimQueueDeal);
  const agenda = groupShipByAgenda(
    openJobs.filter((item): item is TrackerAssistantQueueDeal & { shipBy: string } => Boolean(item.shipBy)),
    shipByCalendarDate(),
  );
  return {
    summary: queue.summary,
    nextPrint: queue.nextPrint.slice(0, 6).map(slimQueueDeal),
    shipReady: queue.shipReady.slice(0, 6).map(slimQueueDeal),
    blocked: queue.blocked.slice(0, 6).map(slimQueueDeal),
    needsReply: queue.needsReply.slice(0, 8).map(slimQueueDeal),
    readyToPack: queue.readyToPack.slice(0, 8).map(slimQueueDeal),
    needsLabel: needsLabelSource.slice(0, 8).map(slimQueueDeal),
    needsAddress: needsAddressSource.slice(0, 8).map(slimQueueDeal),
    shipAgenda: {
      today: agenda.today,
      overdue: agenda.overdue.slice(0, 12),
      dueToday: agenda.dueToday.slice(0, 12),
      thisWeek: agenda.thisWeek.slice(0, 12),
    },
  };
}

export function getTrackerAssistantApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TRACKER_ASSISTANT_API_KEY?.trim() ||
    env.XAI_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    env.CUSTOM_CRED_OPENAI_API_KEY_TOKEN?.trim() ||
    ""
  );
}

export function getTrackerAssistantBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TRACKER_ASSISTANT_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function getTrackerAssistantModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRACKER_ASSISTANT_MODEL?.trim()) return env.TRACKER_ASSISTANT_MODEL.trim();
  const base = getTrackerAssistantBaseUrl(env);
  // xAI OpenAI-compatible endpoint → Grok by default.
  if (/api\.x\.ai/i.test(base)) return "grok-3-mini";
  return "gpt-4o-mini";
}

function classifyIntent(
  question: string,
): "briefing" | "next" | "plates" | "costs" | "stuck" | "intake" | "reminder" | "chase" | "margin" | "shipping" | "due" | "address" | "help" {
  const q = question.toLowerCase();
  if (/\b(top|what|which|need).{0,30}\b(chase|repl(y|ies)|buyer reply|respond)\b|\b(chase|needs? reply|buyer reply)\b/.test(q)) return "chase";
  if (/\b(remind|nudge|message|marketplace text|draft)\b/.test(q) && !/\baddress\b/.test(q)) return "reminder";
  if (/\b(plates?|ctb|slice|attach)\b/.test(q)) return "plates";
  if (
    /\b(address|ship.?to|shipping address|need(s)? an? address|confirm.{0,20}address)\b/.test(q)
  ) {
    return "address";
  }
  if (
    /\b(due|overdue|ship.?by|ship by|calendar|keep me honest|honesty|what.?s due|whats due)\b/.test(q) ||
    /\b(due today|this week).{0,20}\b(ship|due|order)/.test(q)
  ) {
    return "due";
  }
  if (/\b(labels?|ready.?to.?pack|top pack|pack.?ship|ship.?ready|postage|tracking|pirate ship|shipengine|buy.?label)\b/.test(q)) return "shipping";
  // "shipping cost" / postage amount → costs; bare "shipping" already caught above as labels.
  if (/\b(costs?|labor|material|packaging)\b/.test(q) || /\bshipping (cost|fee|amount)\b/.test(q)) return "costs";
  if (/\b(margins?|profit|revenue)\b/.test(q)) return "margin";
  if (/\b(stuck|stale|idle|no activity|behind)\b/.test(q)) return "stuck";
  if (/\b(intake|pending review|awaiting|buyer form|order form)\b/.test(q)) return "intake";
  if (/\b(next|what should|priorit|today|brief|overview|status|summary|queue)\b/.test(q)) return "briefing";
  if (/\b(help|what can|how do)\b/.test(q)) return "help";
  if (q.trim().length < 3) return "briefing";
  return "next";
}

function attentionMatching(
  snapshot: PerformanceResponse,
  predicate: (issue: string) => boolean,
): PerformanceResponse["attention"] {
  return snapshot.attention.filter((item) => predicate(item.issue.toLowerCase()));
}

export function answerTrackerQuestionRules(question: string, ctx: TrackerAssistantContext): TrackerAssistantAnswer {
  const { snapshot, awaitingLinks, pendingLinks, queue } = ctx;
  const intent = classifyIntent(question);
  const actions: TrackerAssistantAction[] = [];
  const usedFacts: string[] = [];
  const lines: string[] = [];

  const plateIssues = attentionMatching(snapshot, (issue) => issue.includes("ctb") || issue.includes("plate"));
  const costIssues = attentionMatching(snapshot, (issue) => issue.includes("cost"));
  const marginIssues = attentionMatching(snapshot, (issue) => issue.includes("margin"));
  const staleIssues = attentionMatching(snapshot, (issue) => issue.includes("activity") || issue.includes("stale"));
  const needsLabel = queue?.needsLabel ?? [];
  const needsReply = queue?.needsReply ?? [];
  const readyToPack = queue?.readyToPack ?? [];
  const shipReadyCount = queue?.summary.shipReady ?? 0;

  usedFacts.push(
    `pendingReview=${snapshot.intake.pendingReview}`,
    `awaitingClient=${snapshot.intake.awaitingClient}`,
    `activeOrders=${snapshot.summary.activeOrders}`,
    `attentionCount=${snapshot.summary.attentionCount}`,
  );
  if (queue) {
    usedFacts.push(
      `queueNext=${queue.summary.nextPrint}`,
      `queueShipReady=${queue.summary.shipReady}`,
      `queueBlocked=${queue.summary.blocked}`,
      `needsLabel=${needsLabel.length}`,
      `needsReply=${needsReply.length}`,
      `readyToPack=${readyToPack.length}`,
      `needsAddress=${queue.needsAddress?.length ?? queue.summary.needsAddress ?? 0}`,
    );
  }

  const needsAddress = queue?.needsAddress ?? [];

  if (intent === "help") {
    return {
      ok: true,
      mode: "rules",
      reply:
        "I read your tracker only — no HubSpot writes. Ask things like:\n" +
        "• What should I do next?\n" +
        "• What’s due / overdue this week?\n" +
        "• What needs an address before label buy?\n" +
        "• Which deals need plates?\n" +
        "• What’s ship-ready / needs a label?\n" +
        "• What’s stuck or missing costs?\n" +
        "• Draft a Marketplace reminder for awaiting buyers\n" +
        "• How are margins looking?",
      actions: [
        { label: "Open Floor", href: "/" },
        { label: "Open Queue", href: "/queue" },
        { label: "Labels", href: "/labels" },
        { label: "Performance", href: "/performance" },
      ],
      usedFacts: ["capabilities"],
    };
  }

  if (intent === "reminder") {
    if (awaitingLinks.length === 0) {
      return {
        ok: true,
        mode: "rules",
        reply: "No buyer forms are still awaiting details, so there’s nothing to nudge right now.",
        actions: [{ label: "Paid order intake", href: "/orders" }],
        usedFacts,
      };
    }
    const link = awaitingLinks[0]!;
    const item = link.itemDescription || link.internalLabel || "your order";
    const draft = `Hi — please fill in this short order form for ${item} ($${link.agreedAmount}) when you can. It only collects delivery details (no payment on the form). Thanks!`;
    lines.push(`Draft for the oldest awaiting link (${link.internalLabel || `intake #${link.id}`}):`);
    lines.push("");
    lines.push(draft);
    if (awaitingLinks.length > 1) {
      lines.push("");
      lines.push(`There ${awaitingLinks.length === 2 ? "is" : "are"} ${awaitingLinks.length - 1} more awaiting form${awaitingLinks.length - 1 === 1 ? "" : "s"} you can nudge the same way.`);
    }
    actions.push({ label: "Open intake queue", href: "/orders" });
    usedFacts.push(`awaitingLinks=${awaitingLinks.length}`);
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions, usedFacts };
  }

  if (intent === "address") {
    usedFacts.push(`needsAddress=${needsAddress.length}`);
    if (needsAddress.length === 0) {
      return {
        ok: true,
        mode: "rules",
        reply:
          queue
            ? "No Ready to Ship orders are missing a HubSpot ship-to right now. Address-ready deals can rate-shop on Labels."
            : "I don’t have production-queue address readiness loaded — open Labels or Floor.",
        actions: [
          { label: "Open Labels", href: "/labels" },
          { label: "Open Floor", href: "/" },
        ],
        usedFacts,
      };
    }
    lines.push(
      `${needsAddress.length} Ready to Ship order${needsAddress.length === 1 ? "" : "s"} need${needsAddress.length === 1 ? "s" : ""} an address chase:`,
    );
    lines.push("");
    for (const deal of needsAddress.slice(0, 5)) {
      const status = deal.addressStatus === "partial" ? "partial" : "missing";
      const where = deal.addressSummary ? ` · ${deal.addressSummary}` : "";
      lines.push(`• ${deal.dealName} — ${status}${where}${deal.amount ? ` · ${money(deal.amount)}` : ""}`);
      if (deal.chaseDraft) {
        lines.push(`  Draft: ${deal.chaseDraft}`);
      }
      actions.push({ label: `Label · ${deal.dealName.slice(0, 24)}`, href: labelsHref(deal.dealId) });
    }
    lines.push("");
    lines.push("Copy the draft into Messenger/email — I never send it for you.");
    actions.push({ label: "Open Labels", href: "/labels" });
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions: actions.slice(0, 6), usedFacts };
  }

  if (intent === "due") {
    const agenda = queue?.shipAgenda;
    const today = agenda?.today ?? shipByCalendarDate();
    const overdue = agenda?.overdue ?? [];
    const dueToday = agenda?.dueToday ?? [];
    const thisWeek = agenda?.thisWeek ?? [];
    usedFacts.push(
      `shipToday=${today}`,
      `shipOverdue=${overdue.length}`,
      `shipDueToday=${dueToday.length}`,
      `shipThisWeek=${thisWeek.length}`,
    );
    if (overdue.length === 0 && dueToday.length === 0 && thisWeek.length === 0) {
      return {
        ok: true,
        mode: "rules",
        reply:
          queue
            ? `Ship calendar looks clear for ${today} (LA). No overdue, due-today, or next-7-day projected ship-bys on open Print Orders.`
            : "I don’t have production-queue ship-by dates loaded right now — open Floor to see the calendar.",
        actions: [
          { label: "Open Floor", href: "/" },
          { label: "Open Queue", href: "/queue" },
        ],
        usedFacts,
      };
    }
    lines.push(`Ship honesty · ${today} (Los Angeles)`);
    lines.push("");
    if (overdue.length > 0) {
      lines.push(`Overdue (${overdue.length}):`);
      for (const deal of overdue.slice(0, 6)) {
        lines.push(
          `• ${deal.dealName} — ${shipByHonestyLabel(deal.shipBy!, today, deal.shipBySource)}${deal.shipByReason ? ` · ${deal.shipByReason}` : ""}${deal.amount ? ` · ${money(deal.amount)}` : ""}`,
        );
        actions.push({ label: `Ops · ${deal.dealName.slice(0, 24)}`, href: queueHref(deal.dealId) });
      }
      lines.push("");
    }
    if (dueToday.length > 0) {
      lines.push(`Due today (${dueToday.length}):`);
      for (const deal of dueToday.slice(0, 6)) {
        lines.push(
          `• ${deal.dealName} — ${shipByHonestyLabel(deal.shipBy!, today, deal.shipBySource)}${deal.shipByReason ? ` · ${deal.shipByReason}` : ""}${deal.amount ? ` · ${money(deal.amount)}` : ""}`,
        );
        actions.push({ label: `Ops · ${deal.dealName.slice(0, 24)}`, href: queueHref(deal.dealId) });
      }
      lines.push("");
    }
    if (thisWeek.length > 0) {
      lines.push(`Next 7 days (${thisWeek.length}):`);
      for (const deal of thisWeek.slice(0, 6)) {
        lines.push(
          `• ${deal.dealName} — ${shipByHonestyLabel(deal.shipBy!, today, deal.shipBySource)}${deal.shipByReason ? ` · ${deal.shipByReason}` : ""}${deal.amount ? ` · ${money(deal.amount)}` : ""}`,
        );
        actions.push({ label: `Ops · ${deal.dealName.slice(0, 24)}`, href: queueHref(deal.dealId) });
      }
    }
    lines.push("");
    lines.push("Override dates (HubSpot print_ship_by) stick; derived dates move with plates/stage.");
    actions.push({ label: "Floor calendar", href: "/" });
    return { ok: true, mode: "rules", reply: lines.join("\n").trim(), actions: actions.slice(0, 6), usedFacts };
  }

  if (intent === "chase") {
    if (needsReply.length === 0) {
      return {
        ok: true,
        mode: "rules",
        reply: "No open Print Orders are marked as needing a buyer reply.",
        actions: [{ label: "Open Queue", href: "/queue" }],
        usedFacts,
      };
    }
    lines.push(`${needsReply.length} Print Order${needsReply.length === 1 ? "" : "s"} need a shop reply:`);
    for (const deal of needsReply.slice(0, 5)) {
      lines.push(`• ${deal.dealName} — ${deal.stage}${deal.amount ? ` · ${money(deal.amount)}` : ""}`);
      actions.push({ label: `Reply · ${deal.dealName.slice(0, 24)}`, href: queueHref(deal.dealId) });
    }
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions, usedFacts };
  }

  if (intent === "plates") {
    if (plateIssues.length === 0) {
      const missing = snapshot.activeDeals.filter((d) => d.promptAttachPlates);
      if (missing.length === 0) {
        return {
          ok: true,
          mode: "rules",
          reply: "No open Print Orders are flagged for missing CTB plates right now.",
          actions: [{ label: "Print files", href: "/prints" }],
          usedFacts,
        };
      }
      lines.push(`${missing.length} open order${missing.length === 1 ? "" : "s"} still have no attached plates:`);
      for (const deal of missing.slice(0, 5)) {
        lines.push(`• ${deal.dealName} — ${deal.stage}${deal.amount ? ` · ${money(deal.amount)}` : ""}`);
        actions.push({ label: `Attach · ${deal.dealName.slice(0, 28)}`, href: printsHref(deal.dealId) });
      }
      return { ok: true, mode: "rules", reply: lines.join("\n"), actions: actions.slice(0, 4), usedFacts };
    }
    lines.push(`${plateIssues.length} attention item${plateIssues.length === 1 ? "" : "s"} about missing plates:`);
    for (const item of plateIssues.slice(0, 5)) {
      lines.push(`• ${item.dealName} (${item.stage}) — ${item.detail}`);
      actions.push({ label: `Attach · ${item.dealName.slice(0, 28)}`, href: printsHref(item.dealId) });
    }
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions: actions.slice(0, 4), usedFacts };
  }

  if (intent === "shipping") {
    if (readyToPack.length === 0 && needsLabel.length === 0 && shipReadyCount === 0) {
      return {
        ok: true,
        mode: "rules",
        reply:
          queue
            ? `Nothing is ship-ready yet. Queue: ${queue.summary.nextPrint} next print · ${queue.summary.inProduction} in production · ${queue.summary.blocked} blocked.`
            : "No ship-ready orders are flagged right now. Check Queue when packs are ready, then buy or drop a label on Labels.",
        actions: [
          { label: "Open Queue", href: "/queue" },
          { label: "Labels", href: "/labels" },
        ],
        usedFacts,
      };
    }
    const packList = readyToPack.length > 0 ? readyToPack : needsLabel;
    if (packList.length > 0) {
      lines.push(
        `${packList.length} order${packList.length === 1 ? " is" : "s are"} ready to pack / ship:`,
      );
      for (const deal of packList.slice(0, 5)) {
        const gaps: string[] = [];
        if (!deal.labelBought) gaps.push("no label");
        if (!deal.trackingPasted) gaps.push("no tracking");
        if (!deal.readyToPack && gaps.length === 0) gaps.push("confirm packing");
        lines.push(
          `• ${deal.dealName} — ${deal.stage}${deal.amount ? ` · ${money(deal.amount)}` : ""}${gaps.length ? ` · ${gaps.join(", ")}` : ""}`,
        );
        actions.push({ label: `Label · ${deal.dealName.slice(0, 24)}`, href: labelsHref(deal.dealId) });
      }
    } else {
      lines.push(
        `${shipReadyCount} order${shipReadyCount === 1 ? "" : "s"} in the ship-ready bucket — labels/tracking already look started. Open Labels to buy or attach PDFs.`,
      );
      actions.push({ label: "Open Labels", href: "/labels" });
    }
    if (queue && queue.summary.nextPrint > 0) {
      lines.push("");
      lines.push(`Also: ${queue.summary.nextPrint} still need plates before they can ship.`);
    }
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions: actions.slice(0, 5), usedFacts };
  }

  if (intent === "costs") {
    if (costIssues.length === 0) {
      return {
        ok: true,
        mode: "rules",
        reply:
          "No open orders are currently flagged for incomplete cost details. Plate attach seeds material + $0 labor/packaging; enter postage in Queue ops or after a Labels PDF drop. Labor stays in the quoted order amount.",
        actions: [
          { label: "Open Queue", href: "/queue" },
          { label: "Labels", href: "/labels" },
        ],
        usedFacts,
      };
    }
    lines.push(`${costIssues.length} order${costIssues.length === 1 ? "" : "s"} need cost fields filled:`);
    for (const item of costIssues.slice(0, 5)) {
      lines.push(`• ${item.dealName} — ${item.detail}`);
      actions.push({ label: `Enter costs · ${item.dealName.slice(0, 20)}`, href: queueHref(item.dealId) });
    }
    lines.push("");
    lines.push(
      "Revenue is the quoted order amount. Open Queue ops to enter postage (and any blanks). Plate attach already seeds material + $0 labor/packaging — labor stays in the quote by default.",
    );
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions: actions.slice(0, 4), usedFacts };
  }

  if (intent === "margin") {
    lines.push(
      `Last ${snapshot.period.days} days: ${money(snapshot.summary.revenue)} revenue · ${money(snapshot.summary.grossProfit)} gross profit · ${snapshot.summary.weightedMarginPercent.toFixed(1)}% weighted margin across ${snapshot.summary.orders} order${snapshot.summary.orders === 1 ? "" : "s"}.`,
    );
    if (marginIssues.length > 0) {
      lines.push("");
      lines.push(`Low-margin attention (${snapshot.thresholds.marginPercent}% threshold):`);
      for (const item of marginIssues.slice(0, 4)) {
        lines.push(`• ${item.dealName} — ${item.detail}`);
      }
    } else {
      lines.push("No open deals are currently flagged below the margin threshold.");
    }
    actions.push({ label: "Full performance", href: "/performance" });
    usedFacts.push(`weightedMargin=${snapshot.summary.weightedMarginPercent}`);
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions, usedFacts };
  }

  if (intent === "stuck") {
    if (staleIssues.length === 0 && plateIssues.length === 0 && costIssues.length === 0) {
      return {
        ok: true,
        mode: "rules",
        reply: "Nothing looks stuck — no stale activity, missing plates, or incomplete costs in the current attention list.",
        actions: [{ label: "Active orders glance", href: "/" }],
        usedFacts,
      };
    }
    lines.push("Here’s what looks stuck or incomplete:");
    for (const item of [...staleIssues, ...plateIssues, ...costIssues].slice(0, 6)) {
      lines.push(`• ${item.dealName} (${item.stage}) — ${item.issue}: ${item.detail}`);
      if (/plate|ctb|ultx|slice/i.test(item.issue)) {
        actions.push({ label: `Attach · ${item.dealName.slice(0, 24)}`, href: printsHref(item.dealId) });
      } else if (/cost/i.test(item.issue)) {
        actions.push({ label: `Enter costs · ${item.dealName.slice(0, 24)}`, href: queueHref(item.dealId) });
      } else {
        actions.push({ label: `Queue · ${item.dealName.slice(0, 24)}`, href: queueHref(item.dealId) });
      }
    }
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions: actions.slice(0, 5), usedFacts };
  }

  if (intent === "intake") {
    lines.push(
      `Intake queue: ${snapshot.intake.pendingReview} pending review · ${snapshot.intake.awaitingClient} awaiting buyer · ${snapshot.intake.approved} already approved.`,
    );
    if (pendingLinks.length > 0) {
      lines.push("");
      lines.push("Ready for your review:");
      for (const link of pendingLinks.slice(0, 4)) {
        lines.push(
          `• ${link.internalLabel || `Intake #${link.id}`} — ${link.clientFullName || "buyer"} · $${link.agreedAmount} · ${link.itemDescription.slice(0, 60)}`,
        );
      }
      actions.push({ label: "Review intake", href: "/orders" });
    }
    if (awaitingLinks.length > 0) {
      lines.push("");
      lines.push("Still waiting on the buyer:");
      for (const link of awaitingLinks.slice(0, 4)) {
        lines.push(`• ${link.internalLabel || `Intake #${link.id}`} — $${link.agreedAmount} · expires ${link.expiresAt.slice(0, 10)}`);
      }
      actions.push({ label: "Copy reminders in intake", href: "/orders" });
    }
    if (pendingLinks.length === 0 && awaitingLinks.length === 0) {
      lines.push("The intake queue is clear.");
    }
    usedFacts.push(`pendingLinks=${pendingLinks.length}`, `awaitingLinks=${awaitingLinks.length}`);
    return { ok: true, mode: "rules", reply: lines.join("\n"), actions, usedFacts };
  }

  // briefing / next (default)
  lines.push("Here’s your tracker briefing:");
  lines.push("");
  const priorities: string[] = [];
  const shipAgenda = queue?.shipAgenda;
  if (shipAgenda && shipAgenda.overdue.length > 0) {
    priorities.push(
      `${priorities.length + 1}. ${shipAgenda.overdue.length} overdue ship-by${shipAgenda.overdue.length === 1 ? "" : "s"} — start with ${shipAgenda.overdue[0]!.dealName}.`,
    );
    actions.push({ label: "Overdue on Floor", href: "/" });
  }
  if (shipAgenda && shipAgenda.dueToday.length > 0) {
    priorities.push(
      `${priorities.length + 1}. ${shipAgenda.dueToday.length} due today — keep ${shipAgenda.dueToday[0]!.dealName} honest.`,
    );
    actions.push({ label: "Due today", href: "/" });
  }
  if (needsAddress.length > 0) {
    priorities.push(
      `${priorities.length + 1}. Confirm ship-to on ${needsAddress.length} Ready to Ship order${needsAddress.length === 1 ? "" : "s"} (start with ${needsAddress[0]!.dealName}).`,
    );
    actions.push({ label: "Needs address", href: labelsHref(needsAddress[0]?.dealId) });
  }
  if (snapshot.intake.pendingReview > 0) {
    priorities.push(
      `1. Review ${snapshot.intake.pendingReview} submitted buyer form${snapshot.intake.pendingReview === 1 ? "" : "s"} before creating HubSpot records.`,
    );
    actions.push({ label: "Review intake", href: "/orders" });
  }
  if (plateIssues.length > 0 || snapshot.activeDeals.some((d) => d.promptAttachPlates)) {
    const count = plateIssues.length || snapshot.activeDeals.filter((d) => d.promptAttachPlates).length;
    priorities.push(`${priorities.length + 1}. Attach CTB plates on ${count} open order${count === 1 ? "" : "s"}.`);
    const first = plateIssues[0] ?? snapshot.activeDeals.find((d) => d.promptAttachPlates);
    if (first) {
      const dealId = "dealId" in first ? first.dealId : (first as { dealId: string }).dealId;
      actions.push({ label: "Attach plates", href: printsHref(dealId) });
    }
  }
  if (costIssues.length > 0) {
    priorities.push(`${priorities.length + 1}. Fill missing costs on ${costIssues.length} deal${costIssues.length === 1 ? "" : "s"} in Queue.`);
    actions.push({ label: "Enter costs", href: queueHref(costIssues[0]!.dealId) });
  }
  if (readyToPack.length > 0 || needsLabel.length > 0 || shipReadyCount > 0) {
    const count = readyToPack.length || needsLabel.length || shipReadyCount;
    priorities.push(
      `${priorities.length + 1}. ${count} order${count === 1 ? "" : "s"} ready to pack / ship (ship-ready)${readyToPack[0] ? ` (start with ${readyToPack[0].dealName})` : ""}.`,
    );
    actions.push({
      label: "Pack / ship",
      href: labelsHref(readyToPack[0]?.dealId ?? needsLabel[0]?.dealId),
    });
  }
  if (needsReply.length > 0) {
    priorities.push(`${priorities.length + 1}. Chase ${needsReply.length} buyer repl${needsReply.length === 1 ? "y" : "ies"} owed by the shop${needsReply[0] ? ` (start with ${needsReply[0].dealName})` : ""}.`);
    actions.push({ label: "Top chase", href: queueHref(needsReply[0]?.dealId ?? "") });
  }
  if (snapshot.intake.awaitingClient > 0) {
    priorities.push(
      `${priorities.length + 1}. ${snapshot.intake.awaitingClient} order form${snapshot.intake.awaitingClient === 1 ? "" : "s"} still awaiting the buyer — nudge if needed.`,
    );
    actions.push({ label: "Awaiting clients", href: "/orders" });
  }
  if (staleIssues.length > 0) {
    priorities.push(`${priorities.length + 1}. Check ${staleIssues.length} stale deal${staleIssues.length === 1 ? "" : "s"} with no recent HubSpot activity.`);
  }
  if (priorities.length === 0) {
    lines.push(
      `Queue looks clear. ${snapshot.summary.activeOrders} active Print Order${snapshot.summary.activeOrders === 1 ? "" : "s"} · ${money(snapshot.summary.revenue)} revenue in the last ${snapshot.period.days} days.`,
    );
    actions.push({ label: "Full performance", href: "/performance" });
  } else {
    lines.push(...priorities);
    lines.push("");
    const queueBit = queue
      ? ` · queue ${queue.summary.nextPrint}/${queue.summary.inProduction}/${queue.summary.shipReady}/${queue.summary.blocked} (next/prod/ship/blocked)`
      : "";
    lines.push(
      `Snapshot: ${snapshot.summary.activeOrders} active · ${snapshot.summary.attentionCount} attention · intake ${snapshot.intake.pendingReview}/${snapshot.intake.awaitingClient} (review/awaiting)${queueBit}.`,
    );
  }

  // Deduplicate actions by href
  const seen = new Set<string>();
  const uniqueActions = actions.filter((action) => {
    if (seen.has(action.href)) return false;
    seen.add(action.href);
    return true;
  });

  return { ok: true, mode: "rules", reply: lines.join("\n"), actions: uniqueActions.slice(0, 5), usedFacts };
}

function contextForModel(ctx: TrackerAssistantContext): string {
  const { snapshot, awaitingLinks, pendingLinks, queue } = ctx;
  return JSON.stringify(
    {
      summary: snapshot.summary,
      intake: snapshot.intake,
      thresholds: snapshot.thresholds,
      periodDays: snapshot.period.days,
      attention: snapshot.attention,
      activeDeals: snapshot.activeDeals,
      pipeline: snapshot.pipeline.filter((stage) => !stage.closed && stage.count > 0),
      productionQueue: queue
        ? {
            summary: queue.summary,
            nextPrint: queue.nextPrint,
            shipReady: queue.shipReady,
            blocked: queue.blocked,
            needsReply: queue.needsReply,
            readyToPack: queue.readyToPack,
            needsLabel: queue.needsLabel,
            needsAddress: queue.needsAddress,
            shipAgenda: queue.shipAgenda ?? null,
          }
        : null,
      awaitingLinks: awaitingLinks.map((link) => ({
        id: link.id,
        label: link.internalLabel,
        item: link.itemDescription,
        amount: link.agreedAmount,
        expiresAt: link.expiresAt,
        status: ORDER_INTAKE_STATUS_LABELS[link.status],
      })),
      pendingLinks: pendingLinks.map((link) => ({
        id: link.id,
        label: link.internalLabel,
        buyer: link.clientFullName,
        item: link.itemDescription,
        amount: link.agreedAmount,
        status: ORDER_INTAKE_STATUS_LABELS[link.status],
      })),
      hubspotPortalId: snapshot.hubspotPortalId,
      rules: [
        "Read-only. Never claim you updated HubSpot, costs, stages, or deals.",
        "Only use facts from this JSON. If unknown, say so.",
        "Prefer concrete next actions with deal/intake names.",
        "Use shipAgenda (overdue / dueToday / thisWeek) to keep the owner honest on ship-by dates. Mark override vs derived when present.",
        "Use needsAddress + chaseDraft for Ready to Ship deals missing HubSpot ship-to. Never invent addresses; never claim you messaged the buyer.",
        "For ship-ready work, point to Labels (/labels?dealId=…) or Queue.",
        "For Marketplace reminders, draft short buyer-facing text.",
        "Keep answers under ~180 words unless drafting a message.",
      ],
    },
    null,
    2,
  );
}

async function answerWithModel(
  question: string,
  ctx: TrackerAssistantContext,
): Promise<TrackerAssistantAnswer | null> {
  const apiKey = getTrackerAssistantApiKey();
  if (!apiKey) return null;

  const base = getTrackerAssistantBaseUrl();
  const model = getTrackerAssistantModel();
  const fallback = answerTrackerQuestionRules(question, ctx);

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are the Print Operations shop-floor assistant. You help the owner prioritize Queue, Labels, plates, costs, intake, and ship-by honesty from structured tracker JSON. You cannot write to HubSpot or change data. Be concise and practical.",
          },
          {
            role: "user",
            content: `Tracker JSON:\n${contextForModel(ctx)}\n\nOwner question: ${question}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return fallback;
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return fallback;
    return {
      ok: true,
      mode: "model",
      reply,
      actions: fallback.actions,
      usedFacts: [...fallback.usedFacts, `model=${model}`, `base=${base}`],
    };
  } catch {
    return fallback;
  }
}

export async function answerTrackerQuestion(
  question: string,
  ctx: TrackerAssistantContext,
): Promise<TrackerAssistantAnswer> {
  const cleaned = question.trim().slice(0, 500);
  if (!cleaned) {
    return answerTrackerQuestionRules("What should I do next?", ctx);
  }
  const modeled = await answerWithModel(cleaned, ctx);
  return modeled ?? answerTrackerQuestionRules(cleaned, ctx);
}
