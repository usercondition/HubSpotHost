/**
 * Read-only tracker assistant for the owner hub.
 *
 * Builds answers from the live Performance snapshot + intake queue only.
 * Never writes to HubSpot. Optional OpenAI-compatible model when a key is set;
 * otherwise a deterministic intent engine answers from structured data.
 */

import type { PerformanceResponse, OrderIntakeLink } from "../../shared/schema";
import { ORDER_INTAKE_STATUS_LABELS } from "../../shared/schema";

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

export type TrackerAssistantContext = {
  snapshot: PerformanceResponse;
  awaitingLinks: Array<Pick<OrderIntakeLink, "id" | "internalLabel" | "itemDescription" | "agreedAmount" | "expiresAt" | "status">>;
  pendingLinks: Array<Pick<OrderIntakeLink, "id" | "internalLabel" | "itemDescription" | "agreedAmount" | "clientFullName" | "status">>;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function printsHref(dealId: string): string {
  return `/prints?dealId=${encodeURIComponent(dealId)}`;
}

function hubspotDealHref(dealId: string, portalId: string | null): string | null {
  const portal = String(portalId ?? "").trim();
  if (!portal || !dealId) return null;
  return `https://app.hubspot.com/contacts/${encodeURIComponent(portal)}/record/0-3/${encodeURIComponent(dealId)}`;
}

export function getTrackerAssistantApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TRACKER_ASSISTANT_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    env.CUSTOM_CRED_OPENAI_API_KEY_TOKEN?.trim() ||
    ""
  );
}

export function getTrackerAssistantModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRACKER_ASSISTANT_MODEL?.trim() || "gpt-4o-mini";
}

export function getTrackerAssistantBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TRACKER_ASSISTANT_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function classifyIntent(question: string): "briefing" | "next" | "plates" | "costs" | "stuck" | "intake" | "reminder" | "margin" | "help" {
  const q = question.toLowerCase();
  if (/\b(remind|nudge|message|marketplace text|draft)\b/.test(q)) return "reminder";
  if (/\b(plates?|ctb|slice|attach)\b/.test(q)) return "plates";
  if (/\b(costs?|shipping|labor|material|packaging)\b/.test(q)) return "costs";
  if (/\b(margins?|profit|revenue)\b/.test(q)) return "margin";
  if (/\b(stuck|stale|idle|no activity|behind)\b/.test(q)) return "stuck";
  if (/\b(intake|pending review|awaiting|buyer form|order form|queue)\b/.test(q)) return "intake";
  if (/\b(next|what should|priorit|today|brief|overview|status|summary)\b/.test(q)) return "briefing";
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
  const { snapshot, awaitingLinks, pendingLinks } = ctx;
  const intent = classifyIntent(question);
  const actions: TrackerAssistantAction[] = [];
  const usedFacts: string[] = [];
  const lines: string[] = [];

  const plateIssues = attentionMatching(snapshot, (issue) => issue.includes("ctb") || issue.includes("plate"));
  const costIssues = attentionMatching(snapshot, (issue) => issue.includes("cost"));
  const marginIssues = attentionMatching(snapshot, (issue) => issue.includes("margin"));
  const staleIssues = attentionMatching(snapshot, (issue) => issue.includes("activity") || issue.includes("stale"));

  usedFacts.push(
    `pendingReview=${snapshot.intake.pendingReview}`,
    `awaitingClient=${snapshot.intake.awaitingClient}`,
    `activeOrders=${snapshot.summary.activeOrders}`,
    `attentionCount=${snapshot.summary.attentionCount}`,
  );

  if (intent === "help") {
    return {
      ok: true,
      mode: "rules",
      reply:
        "I read your tracker only — no HubSpot writes. Ask things like:\n" +
        "• What should I do next?\n" +
        "• Which deals need plates?\n" +
        "• What’s stuck or missing costs?\n" +
        "• Draft a Marketplace reminder for awaiting buyers\n" +
        "• How are margins looking?",
      actions: [{ label: "Open Performance", href: "/performance" }],
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

  if (intent === "plates") {
    if (plateIssues.length === 0) {
      const missing = snapshot.activeDeals.filter((d) => !d.hasPlates);
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

  if (intent === "costs") {
    if (costIssues.length === 0) {
      return {
        ok: true,
        mode: "rules",
        reply:
          "No open orders are currently flagged for incomplete cost details. When plates are attached, use Print files → Apply cost defaults to fill blanks with a confirm step.",
        actions: [
          { label: "Print files", href: "/prints" },
          { label: "Open HubSpot deals", href: "/performance" },
        ],
        usedFacts,
      };
    }
    lines.push(`${costIssues.length} order${costIssues.length === 1 ? "" : "s"} need cost fields filled in HubSpot:`);
    for (const item of costIssues.slice(0, 5)) {
      lines.push(`• ${item.dealName} — ${item.detail}`);
      actions.push({ label: `Cost defaults · ${item.dealName.slice(0, 20)}`, href: printsHref(item.dealId) });
      const href = hubspotDealHref(item.dealId, snapshot.hubspotPortalId);
      if (href) actions.push({ label: `HubSpot · ${item.dealName.slice(0, 24)}`, href, external: true });
    }
    lines.push("");
    lines.push("On Print files, preview proposed material/labor/packaging (and paste shipping), then confirm before any HubSpot write.");
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
      if (/plate|ctb/i.test(item.issue)) {
        actions.push({ label: `Attach · ${item.dealName.slice(0, 24)}`, href: printsHref(item.dealId) });
      } else {
        const href = hubspotDealHref(item.dealId, snapshot.hubspotPortalId);
        if (href) actions.push({ label: `HubSpot · ${item.dealName.slice(0, 24)}`, href, external: true });
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
  if (snapshot.intake.pendingReview > 0) {
    priorities.push(
      `1. Review ${snapshot.intake.pendingReview} submitted buyer form${snapshot.intake.pendingReview === 1 ? "" : "s"} before creating HubSpot records.`,
    );
    actions.push({ label: "Review intake", href: "/orders" });
  }
  if (plateIssues.length > 0 || snapshot.activeDeals.some((d) => !d.hasPlates)) {
    const count = plateIssues.length || snapshot.activeDeals.filter((d) => !d.hasPlates).length;
    priorities.push(`${priorities.length + 1}. Attach CTB plates on ${count} open order${count === 1 ? "" : "s"}.`);
    const first = plateIssues[0] ?? snapshot.activeDeals.find((d) => !d.hasPlates);
    if (first) {
      const dealId = "dealId" in first ? first.dealId : (first as { dealId: string }).dealId;
      actions.push({ label: "Attach plates", href: printsHref(dealId) });
    }
  }
  if (costIssues.length > 0) {
    priorities.push(`${priorities.length + 1}. Fill missing costs on ${costIssues.length} deal${costIssues.length === 1 ? "" : "s"} in HubSpot.`);
    const href = hubspotDealHref(costIssues[0]!.dealId, snapshot.hubspotPortalId);
    if (href) actions.push({ label: "Update costs", href, external: true });
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
    lines.push(
      `Snapshot: ${snapshot.summary.activeOrders} active · ${snapshot.summary.attentionCount} attention · intake ${snapshot.intake.pendingReview}/${snapshot.intake.awaitingClient} (review/awaiting).`,
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
  const { snapshot, awaitingLinks, pendingLinks } = ctx;
  return JSON.stringify(
    {
      summary: snapshot.summary,
      intake: snapshot.intake,
      thresholds: snapshot.thresholds,
      periodDays: snapshot.period.days,
      attention: snapshot.attention,
      activeDeals: snapshot.activeDeals,
      pipeline: snapshot.pipeline.filter((stage) => !stage.closed && stage.count > 0),
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
              "You are the Print Operations tracker assistant. You help the owner prioritize daily work from structured tracker JSON. You cannot write to HubSpot or change data. Be concise and practical.",
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
      usedFacts: [...fallback.usedFacts, "model=openai-compatible"],
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
