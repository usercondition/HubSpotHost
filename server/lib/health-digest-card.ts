/**
 * Floor-style health-check card for Telegram.
 *
 * Same charcoal bench, amber marks, and glance language as Print Ops —
 * a status board, not a newspaper. Buttons under the photo open the app.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import type { TrackerAssistantContext } from "./tracker-assistant";

const CARD_WIDTH = 1080;
/** Telegram compresses sendPhoto; a 2.5× raster stays sharp on a phone. */
const RENDER_WIDTH = 2560;
const ISSUE_ORDER = ["no_plates", "costs_incomplete", "stale"] as const;

const SANS = "Space Grotesk, Liberation Sans, DejaVu Sans, sans-serif";
const MONO = "IBM Plex Mono, Liberation Mono, DejaVu Sans Mono, monospace";

const BENCH = "#0f1114";
const CARD = "#16181d";
const BORDER = "#2a2e35";
const INK = "#f1f0ee";
const MUTED = "#93979f";
const TEAL = "#22c1d3";
const AMBER = TEAL;
const WARN = "#f9a410";
const LIVE = "#34b277";
const BAD = "#df3a3a";

export type DigestSection = {
  key: string;
  kicker: string;
  hint: string;
  items: Array<{ name: string; stage: string }>;
  overflow: number;
};

export type DigestGlanceRow = {
  name: string;
  badge: string;
  detail: string;
  tone: "warn" | "bad" | "good" | "neutral";
};

export type DigestMetric = {
  label: string;
  value: number;
  hint: string;
  tone: "warn" | "bad" | "good" | "neutral";
};

export type DigestList = {
  eyebrow: string;
  title: string;
  rows: DigestGlanceRow[];
};

export type HealthDigestEdition = {
  title: string;
  kicker: string;
  dateLine: string;
  weekday: string;
  lede: string;
  deck: string;
  pill: string;
  intakeLine: string | null;
  sections: DigestSection[];
  rows: DigestGlanceRow[];
  lists: DigestList[];
  metrics: DigestMetric[];
  folio: string;
  allClear: boolean;
  openCount: number;
};

export function shopDigestTitle(raw?: string): string {
  return (
    (raw?.trim() || "Print Ops")
      .replace(/\s+[—-]\s+(health check|morning briefing).*$/i, "")
      .trim() || "Print Ops"
  );
}

export function digestSectionMeta(issueKey: string): {
  kicker: string;
  hint: string;
  badge: string;
  deck: (count: number) => string;
} {
  switch (issueKey) {
    case "no_plates":
      return {
        kicker: "Need plates",
        hint: "Attach CTB / slice files",
        badge: "Needs plates",
        deck: (count) => (count === 1 ? "1 need plates" : `${count} need plates`),
      };
    case "costs_incomplete":
      return {
        kicker: "Need costs",
        hint: "Material / labor / ship",
        badge: "Needs costs",
        deck: (count) => (count === 1 ? "1 need costs" : `${count} need costs`),
      };
    case "stale":
      return {
        kicker: "Stale",
        hint: "No HubSpot update lately",
        badge: "Stale",
        deck: (count) => (count === 1 ? "1 stale" : `${count} stale`),
      };
    default:
      return {
        kicker: "Attention",
        hint: "Needs a look",
        badge: "Open",
        deck: (count) => `${count} open`,
      };
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clip(value: string, limit: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).trim()}…`;
}

function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return {
    weekday: read("weekday"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    dayPeriod: read("dayPeriod"),
  };
}

function shopDateLine(now: Date, timeZone: string): string {
  const { weekday, month, day, hour, minute, dayPeriod } = localParts(now, timeZone);
  return `${weekday.slice(0, 3)} ${day} ${month} · ${hour}:${minute} ${dayPeriod}`;
}

function toneHex(tone: DigestMetric["tone"] | DigestGlanceRow["tone"]): string {
  if (tone === "bad") return BAD;
  if (tone === "good") return LIVE;
  if (tone === "warn") return WARN;
  return MUTED;
}

export function buildHealthDigestEdition(
  ctx: TrackerAssistantContext,
  options?: { title?: string; now?: Date; timeZone?: string },
): HealthDigestEdition {
  const snapshot = ctx.snapshot;
  const attention = snapshot.attention.filter((item) =>
    ISSUE_ORDER.includes(item.issueKey as (typeof ISSUE_ORDER)[number]),
  );
  const pending = snapshot.intake.pendingReview;
  const awaiting = snapshot.intake.awaitingClient;
  const allClear = attention.length === 0 && pending === 0 && awaiting === 0;
  const now = options?.now ?? new Date();
  const timeZone = options?.timeZone || "America/New_York";
  const { weekday } = localParts(now, timeZone);

  const sections: DigestSection[] = [];
  const deckBits: string[] = [];
  for (const key of ISSUE_ORDER) {
    const rows = attention.filter((item) => item.issueKey === key);
    if (rows.length === 0) continue;
    const meta = digestSectionMeta(key);
    sections.push({
      key,
      kicker: meta.kicker,
      hint: meta.hint,
      items: rows.slice(0, 4).map((item) => ({
        name: clip(item.dealName, 36),
        stage: clip(item.stage, 22),
      })),
      overflow: Math.max(0, rows.length - 4),
    });
    deckBits.push(meta.deck(rows.length));
  }

  let intakeLine: string | null = null;
  if (pending > 0) {
    intakeLine = `${pending} intake form${pending === 1 ? "" : "s"} waiting for review`;
  } else if (awaiting > 0 && attention.length === 0) {
    intakeLine = `${awaiting} buyer form${awaiting === 1 ? "" : "s"} still open`;
  }

  const rows: DigestGlanceRow[] = [];
  if (pending > 0) {
    rows.push({
      name: `${pending} intake form${pending === 1 ? "" : "s"} waiting for review`,
      badge: "Intake review",
      detail: "Approve or reject paid order intake",
      tone: "warn",
    });
  } else if (awaiting > 0 && attention.length === 0) {
    rows.push({
      name: `${awaiting} buyer form${awaiting === 1 ? "" : "s"} still open`,
      badge: "Awaiting buyer",
      detail: "Form not finished",
      tone: "warn",
    });
  }
  for (const item of attention.slice(0, pending > 0 ? 4 : 5)) {
    const meta = digestSectionMeta(item.issueKey);
    rows.push({
      name: clip(item.dealName, 34),
      badge: meta.badge,
      detail: clip([item.stage, meta.hint].filter(Boolean).join(" · "), 52),
      tone: item.issueKey === "stale" || item.severity === "bad" ? "bad" : "warn",
    });
  }
  const hidden = attention.length - (pending > 0 ? 4 : 5);
  if (hidden > 0) {
    rows.push({
      name: `and ${hidden} more on the floor`,
      badge: "Open",
      detail: "Queue has the rest",
      tone: "warn",
    });
  }

  const plates = attention.filter((item) => item.issueKey === "no_plates").length;
  const costs = attention.filter((item) => item.issueKey === "costs_incomplete").length;
  const stale = attention.filter((item) => item.issueKey === "stale").length;
  const metrics: DigestMetric[] = [
    { label: "Need plates", value: plates, hint: "CTB / slice files", tone: plates > 0 ? "warn" : "good" },
    { label: "Need costs", value: costs, hint: "Material / ship", tone: costs > 0 ? "warn" : "good" },
    { label: "Stale", value: stale, hint: "No HubSpot update", tone: stale > 0 ? "bad" : "good" },
    { label: "Intake review", value: pending, hint: "Waiting on you", tone: pending > 0 ? "warn" : "neutral" },
    { label: "Awaiting buyer", value: awaiting, hint: "Form not finished", tone: awaiting > 0 ? "warn" : "neutral" },
  ];

  const deck = allClear
    ? "No missing plates, costs, stale jobs, or intake waiting on you."
    : deckBits.join(" · ") || intakeLine || "Open items on the floor.";

  return {
    title: shopDigestTitle(options?.title),
    kicker: "Floor",
    dateLine: shopDateLine(now, timeZone),
    weekday,
    lede: allClear ? "Floor is clear" : "Do this next",
    deck,
    pill: "HEALTH CHECK",
    intakeLine: attention.length > 0 ? (pending > 0 ? intakeLine : null) : null,
    sections,
    rows,
    lists: [],
    metrics,
    folio: `${snapshot.summary.activeOrders} job${snapshot.summary.activeOrders === 1 ? "" : "s"} on the floor`,
    allClear,
    openCount: attention.length + pending,
  };
}

function fontSearchDirs(): string[] {
  const here = typeof import.meta.url === "string" ? dirname(fileURLToPath(import.meta.url)) : process.cwd();
  return [
    join(process.cwd(), "server/fonts"),
    join(process.cwd(), "dist/fonts"),
    join(here, "fonts"),
    join(here, "../fonts"),
    "/usr/share/fonts/truetype/liberation",
    "/usr/share/fonts/opentype",
    "/usr/share/fonts/truetype",
  ];
}

export function digestFontFiles(): string[] {
  const names = [
    "SpaceGrotesk-Regular.otf",
    "SpaceGrotesk-Medium.otf",
    "SpaceGrotesk-Bold.otf",
    "IBMPlexMono-Regular.ttf",
    "IBMPlexMono-Medium.ttf",
    "LiberationSans-Regular.ttf",
    "LiberationSans-Bold.ttf",
    "LiberationMono-Regular.ttf",
    "LiberationSerif-Regular.ttf",
    "LiberationSerif-Bold.ttf",
  ];
  return fontSearchDirs()
    .flatMap((dir) => names.map((name) => join(dir, name)))
    .filter((path) => existsSync(path));
}

function px(value: number): number {
  return Math.round(value);
}

function rgba(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function text(opts: {
  x: number;
  y: number;
  size: number;
  value: string;
  font?: string;
  anchor?: "start" | "middle" | "end";
  weight?: 400 | 500 | 600 | 700;
  fill?: string;
  tracking?: number;
}): string {
  const font = opts.font || SANS;
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : "";
  const weight = opts.weight ? ` font-weight="${opts.weight}"` : "";
  const tracking = opts.tracking != null ? ` letter-spacing="${opts.tracking}"` : "";
  return `<text x="${px(opts.x)}" y="${px(opts.y)}" font-family="${font}" font-size="${px(opts.size)}"${anchor}${weight} fill="${opts.fill || INK}"${tracking}>${escapeXml(opts.value)}</text>`;
}

function markSvg(x: number, y: number, size: number): string {
  const scale = size / 32;
  return `<g transform="translate(${px(x)} ${px(y)}) scale(${scale})" fill="none" stroke="${AMBER}">
    <rect x="4" y="4" width="24" height="24" rx="7" stroke-width="2" opacity="0.4"/>
    <path d="M9 22h14" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M11 17h10" stroke-width="2.2" stroke-linecap="round" opacity="0.75"/>
    <path d="M13 12h6" stroke-width="2.2" stroke-linecap="round" opacity="0.5"/>
    <circle cx="16" cy="8" r="2" fill="${AMBER}" stroke="none"/>
  </g>`;
}

function pill(x: number, y: number, label: string, tone: "warn" | "bad" | "good" | "alert"): { svg: string; width: number } {
  const color = tone === "good" ? LIVE : tone === "bad" ? BAD : WARN;
  const width = px(Math.max(96, 28 + label.length * 8));
  const height = 30;
  const svg = `<g>
    <rect x="${px(x)}" y="${px(y)}" width="${width}" height="${height}" rx="15" fill="${rgba(color, 0.14)}" stroke="${rgba(color, 0.45)}" stroke-width="2"/>
    <circle cx="${px(x + 15)}" cy="${px(y + 15)}" r="4" fill="${color}"/>
    ${text({ x: x + 28, y: y + 20, size: 13, value: label, weight: 700, fill: color, tracking: 1, font: SANS })}
  </g>`;
  return { svg, width };
}

function badge(x: number, y: number, label: string, tone: DigestGlanceRow["tone"]): { svg: string; width: number } {
  const color = toneHex(tone);
  const width = px(Math.max(80, 20 + label.length * 7.2));
  const svg = `<g>
    <rect x="${px(x)}" y="${px(y)}" width="${width}" height="26" rx="7" fill="${rgba(color, 0.14)}" stroke="${rgba(color, 0.4)}" stroke-width="1.5"/>
    ${text({ x: x + width / 2, y: y + 17, size: 13, value: label, anchor: "middle", weight: 600, fill: color })}
  </g>`;
  return { svg, width };
}

function renderGlanceList(rows: DigestGlanceRow[], x: number, y: number, width: number): { svg: string; height: number } {
  const rowH = 70;
  const height = rows.length * rowH;
  const lines: string[] = [
    `<rect x="${px(x)}" y="${px(y)}" width="${px(width)}" height="${px(height)}" rx="14" fill="${CARD}" stroke="${BORDER}" stroke-width="2"/>`,
  ];
  rows.forEach((row, index) => {
    const top = y + index * rowH;
    const stripe = toneHex(row.tone);
    const badgeW = px(Math.max(80, 20 + row.badge.length * 7.2));
    if (index > 0) {
      lines.push(
        `<line x1="${px(x + 18)}" y1="${px(top)}" x2="${px(x + width - 18)}" y2="${px(top)}" stroke="${BORDER}" stroke-width="1"/>`,
      );
    }
    lines.push(`<rect x="${px(x)}" y="${px(top + 12)}" width="4" height="46" rx="2" fill="${stripe}"/>`);
    lines.push(text({ x: x + 24, y: top + 30, size: 20, value: row.name, weight: 600 }));
    lines.push(text({ x: x + 24, y: top + 52, size: 14, value: row.detail, fill: MUTED }));
    lines.push(badge(x + width - 16 - badgeW, top + 22, row.badge, row.tone).svg);
  });
  return { svg: lines.join("\n"), height };
}

function renderMetric(metric: DigestMetric, x: number, y: number, width: number): string {
  const color = toneHex(metric.tone);
  const border =
    metric.tone === "good" ? rgba(LIVE, 0.4) : metric.tone === "bad" ? rgba(BAD, 0.45) : metric.tone === "warn" ? rgba(WARN, 0.45) : BORDER;
  const wash =
    metric.tone === "good" ? rgba(LIVE, 0.1) : metric.tone === "bad" ? rgba(BAD, 0.1) : metric.tone === "warn" ? rgba(WARN, 0.12) : CARD;
  return `<g>
    <rect x="${px(x)}" y="${px(y)}" width="${px(width)}" height="112" rx="14" fill="${wash}" stroke="${border}" stroke-width="2"/>
    ${text({ x: x + 14, y: y + 26, size: 12, value: metric.label.toUpperCase(), weight: 600, fill: MUTED, tracking: 1.2 })}
    ${text({ x: x + 14, y: y + 68, size: 34, value: String(metric.value), weight: 700, fill: color, font: MONO })}
    ${text({ x: x + 14, y: y + 94, size: 13, value: metric.hint, fill: MUTED })}
  </g>`;
}

export function renderHealthDigestSvg(edition: HealthDigestEdition): { svg: string; width: number; height: number } {
  const pad = 44;
  const inner = CARD_WIDTH - pad * 2;
  const parts: string[] = [];
  let y = 40;

  parts.push(markSvg(pad, y, 40));
  parts.push(text({ x: pad + 52, y: y + 18, size: 22, value: edition.title, weight: 700 }));
  parts.push(
    text({
      x: pad + 52,
      y: y + 38,
      size: 14,
      value: `${edition.kicker} · ${edition.dateLine}`,
      font: MONO,
      fill: MUTED,
    }),
  );
  const status = pill(
    CARD_WIDTH - pad - (edition.pill.length > 8 ? 150 : 120),
    y + 6,
    edition.allClear ? "CLEAR" : edition.pill,
    edition.allClear ? "good" : edition.pill === "MORNING" ? "good" : "alert",
  );
  parts.push(status.svg);
  y += 70;

  parts.push(text({ x: pad, y, size: 11, value: "GLANCE", weight: 700, fill: MUTED, tracking: 2.2 }));
  y += 34;
  parts.push(text({ x: pad, y, size: 32, value: edition.lede, weight: 700 }));
  const statusPill = edition.allClear
    ? pill(CARD_WIDTH - pad - 108, y - 24, "CLEAR", "good")
    : pill(CARD_WIDTH - pad - 108, y - 24, `${edition.openCount} OPEN`, "alert");
  parts.push(statusPill.svg);
  y += 28;
  parts.push(text({ x: pad, y, size: 17, value: edition.deck, fill: MUTED }));
  y += 20;

  if (edition.rows.length === 0) {
    if (edition.allClear) {
      parts.push(
        text({
          x: pad,
          y: y + 18,
          size: 16,
          value: "When something needs plates, costs, or review, it shows up here first.",
          fill: MUTED,
        }),
      );
      y += 44;
    }
  } else {
    const list = renderGlanceList(edition.rows, pad, y, inner);
    parts.push(list.svg);
    y += list.height + 28;
  }

  for (const extra of edition.lists) {
    if (extra.rows.length === 0) continue;
    parts.push(text({ x: pad, y, size: 11, value: extra.eyebrow, weight: 700, fill: MUTED, tracking: 2.2 }));
    y += 28;
    if (extra.title) {
      parts.push(text({ x: pad, y, size: 22, value: extra.title, weight: 700 }));
      y += 18;
    }
    const extraList = renderGlanceList(extra.rows, pad, y, inner);
    parts.push(extraList.svg);
    y += extraList.height + 24;
  }

  parts.push(text({ x: pad, y, size: 11, value: "COUNTS", weight: 700, fill: MUTED, tracking: 2.2 }));
  y += 32;
  parts.push(text({ x: pad, y, size: 24, value: "At a glance", weight: 700 }));
  y += 18;
  const gap = 12;
  const tileW = Math.floor((inner - gap * 4) / 5);
  edition.metrics.forEach((metric, index) => {
    parts.push(
      renderMetric(
        { ...metric, hint: clip(metric.hint, 18) },
        pad + index * (tileW + gap),
        y,
        tileW,
      ),
    );
  });
  y += 132;

  parts.push(text({ x: pad, y, size: 14, value: edition.folio, font: MONO, fill: MUTED }));
  parts.push(text({ x: CARD_WIDTH - pad, y, size: 14, value: edition.weekday, font: MONO, fill: MUTED, anchor: "end" }));
  y += 36;

  const height = y + 8;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" text-rendering="geometricPrecision" shape-rendering="geometricPrecision">
  <defs>
    <radialGradient id="wash" cx="8%" cy="0%" r="55%">
      <stop offset="0%" stop-color="${AMBER}" stop-opacity="0.1"/>
      <stop offset="70%" stop-color="${BENCH}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="${BENCH}"/>
  <rect width="100%" height="100%" fill="url(#wash)"/>
  ${parts.join("\n  ")}
</svg>`;
  return { svg, width: CARD_WIDTH, height };
}

export function renderHealthDigestPng(edition: HealthDigestEdition): Buffer {
  const { svg } = renderHealthDigestSvg(edition);
  const fonts = digestFontFiles();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: RENDER_WIDTH },
    font: {
      loadSystemFonts: true,
      fontFiles: fonts,
      defaultFontFamily: "Space Grotesk",
    },
    background: BENCH,
  });
  return Buffer.from(resvg.render().asPng());
}

export function healthDigestCaption(edition: HealthDigestEdition): string {
  if (edition.allClear && edition.pill !== "MORNING") return "Floor is clear.";
  const bits = [edition.lede, edition.deck];
  if (edition.intakeLine && !edition.deck.includes("intake")) bits.push(edition.intakeLine);
  return bits.filter(Boolean).join(" · ");
}

export function isPngBuffer(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  );
}
