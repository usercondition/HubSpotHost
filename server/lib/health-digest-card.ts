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
const ISSUE_ORDER = ["no_plates", "costs_incomplete", "stale"] as const;

const SANS = "Space Grotesk, Liberation Sans, DejaVu Sans, sans-serif";
const MONO = "IBM Plex Mono, Liberation Mono, DejaVu Sans Mono, monospace";

const BENCH = "#0f1114";
const CARD = "#16181d";
const BORDER = "#2a2e35";
const INK = "#f1f0ee";
const MUTED = "#93979f";
const AMBER = "#f69323";
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
  tone: "warn" | "bad";
};

export type DigestMetric = {
  label: string;
  value: number;
  hint: string;
  tone: "warn" | "bad" | "good" | "neutral";
};

export type HealthDigestEdition = {
  title: string;
  kicker: string;
  dateLine: string;
  weekday: string;
  lede: string;
  deck: string;
  intakeLine: string | null;
  sections: DigestSection[];
  rows: DigestGlanceRow[];
  metrics: DigestMetric[];
  folio: string;
  allClear: boolean;
  openCount: number;
};

export function shopDigestTitle(raw?: string): string {
  return (raw?.trim() || "Print Ops").replace(/\s+[—-]\s+health check.*$/i, "").trim() || "Print Ops";
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
    intakeLine: attention.length > 0 ? (pending > 0 ? intakeLine : null) : null,
    sections,
    rows,
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
  return `<text x="${opts.x}" y="${opts.y}" font-family="${font}" font-size="${opts.size}"${anchor}${weight} fill="${opts.fill || INK}"${tracking}>${escapeXml(opts.value)}</text>`;
}

function markSvg(x: number, y: number, size: number): string {
  const scale = size / 32;
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${AMBER}">
    <rect x="3.5" y="3.5" width="25" height="25" rx="7" stroke-width="1.8" opacity="0.35"/>
    <path d="M9 22h14" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M11 17h10" stroke-width="2.2" stroke-linecap="round" opacity="0.75"/>
    <path d="M13 12h6" stroke-width="2.2" stroke-linecap="round" opacity="0.5"/>
    <circle cx="16" cy="8" r="1.7" fill="${AMBER}" stroke="none"/>
  </g>`;
}

function pill(x: number, y: number, label: string, tone: "warn" | "bad" | "good" | "alert"): { svg: string; width: number } {
  const color = tone === "good" ? LIVE : tone === "bad" ? BAD : WARN;
  const width = Math.max(92, 22 + label.length * 8.2);
  const height = 28;
  const svg = `<g>
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${color}24" stroke="${color}66"/>
    <circle cx="${x + 14}" cy="${y + 14}" r="4" fill="${color}"/>
    ${text({ x: x + 26, y: y + 19, size: 12, value: label, weight: 700, fill: color, tracking: 1.1, font: SANS })}
  </g>`;
  return { svg, width };
}

function badge(x: number, y: number, label: string, tone: DigestGlanceRow["tone"]): { svg: string; width: number } {
  const color = toneHex(tone);
  const width = Math.max(78, 16 + label.length * 7.4);
  const svg = `<g>
    <rect x="${x}" y="${y}" width="${width}" height="24" rx="6" fill="${color}22" stroke="${color}59"/>
    ${text({ x: x + width / 2, y: y + 16, size: 12, value: label, anchor: "middle", weight: 600, fill: color })}
  </g>`;
  return { svg, width };
}

function renderGlanceRow(row: DigestGlanceRow, x: number, y: number, width: number): string {
  const stripe = toneHex(row.tone);
  const pillBadge = badge(x + width - 16 - Math.max(78, 16 + row.badge.length * 7.4), y + 16, row.badge, row.tone);
  return `<g>
    <rect x="${x}" y="${y}" width="${width}" height="68" rx="12" fill="${BENCH}73" stroke="${BORDER}"/>
    <rect x="${x}" y="${y + 10}" width="3" height="48" rx="1.5" fill="${stripe}"/>
    ${text({ x: x + 22, y: y + 28, size: 20, value: row.name, weight: 600 })}
    ${text({ x: x + 22, y: y + 50, size: 14, value: row.detail, fill: MUTED })}
    ${pillBadge.svg}
  </g>`;
}

function renderMetric(metric: DigestMetric, x: number, y: number, width: number): string {
  const color = toneHex(metric.tone);
  const border =
    metric.tone === "good" ? `${LIVE}66` : metric.tone === "bad" ? `${BAD}73` : metric.tone === "warn" ? `${WARN}73` : BORDER;
  const wash =
    metric.tone === "good" ? `${LIVE}1a` : metric.tone === "bad" ? `${BAD}1a` : metric.tone === "warn" ? `${WARN}1f` : `${CARD}`;
  return `<g>
    <rect x="${x}" y="${y}" width="${width}" height="118" rx="12" fill="${wash}" stroke="${border}"/>
    ${text({ x: x + 14, y: y + 28, size: 12, value: metric.label.toUpperCase(), weight: 600, fill: MUTED, tracking: 1.4 })}
    ${text({ x: x + 14, y: y + 70, size: 34, value: String(metric.value), weight: 700, fill: color, font: MONO })}
    ${text({ x: x + 14, y: y + 96, size: 13, value: metric.hint, fill: MUTED })}
  </g>`;
}

function sectionChrome(x: number, y: number, width: number, height: number): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" fill="${CARD}" stroke="${BORDER}"/>`;
}

export function renderHealthDigestSvg(edition: HealthDigestEdition): { svg: string; width: number; height: number } {
  const pad = 40;
  const inner = CARD_WIDTH - pad * 2;
  const glancePad = 22;
  const header: string[] = [];
  const glance: string[] = [];
  const counts: string[] = [];
  const footer: string[] = [];
  let y = 44;

  header.push(markSvg(pad, y, 44));
  header.push(text({ x: pad + 56, y: y + 20, size: 22, value: edition.title, weight: 700 }));
  header.push(
    text({
      x: pad + 56,
      y: y + 40,
      size: 14,
      value: `${edition.kicker} · ${edition.dateLine}`,
      font: MONO,
      fill: MUTED,
    }),
  );
  const status = pill(
    CARD_WIDTH - pad - 148,
    y + 8,
    edition.allClear ? "CLEAR" : "HEALTH CHECK",
    edition.allClear ? "good" : "alert",
  );
  header.push(status.svg);
  y += 72;

  const glanceTop = y;
  let gy = glanceTop + 28;
  glance.push(text({ x: pad + glancePad, y: gy, size: 11, value: "GLANCE", weight: 700, fill: MUTED, tracking: 2.2 }));
  gy += 36;
  glance.push(text({ x: pad + glancePad, y: gy, size: 32, value: edition.lede, weight: 700 }));
  if (!edition.allClear) {
    glance.push(pill(CARD_WIDTH - pad - glancePad - 96, gy - 24, `${edition.openCount} OPEN`, "alert").svg);
  } else {
    glance.push(pill(CARD_WIDTH - pad - glancePad - 86, gy - 24, "CLEAR", "good").svg);
  }
  gy += 30;
  glance.push(text({ x: pad + glancePad, y: gy, size: 17, value: edition.deck, fill: MUTED }));
  gy += 22;

  if (edition.allClear) {
    gy += 8;
    glance.push(
      text({
        x: pad + glancePad,
        y: gy + 8,
        size: 16,
        value: "When something needs plates, costs, or review, it shows up here first.",
        fill: MUTED,
      }),
    );
    gy += 36;
  } else {
    for (const row of edition.rows) {
      glance.push(renderGlanceRow(row, pad + glancePad, gy, inner - glancePad * 2));
      gy += 78;
    }
  }
  const glanceHeight = gy - glanceTop + 18;
  y = glanceTop + glanceHeight + 16;

  const countsTop = y;
  let cy = countsTop + 28;
  counts.push(text({ x: pad + glancePad, y: cy, size: 11, value: "COUNTS", weight: 700, fill: MUTED, tracking: 2.2 }));
  cy += 32;
  counts.push(text({ x: pad + glancePad, y: cy, size: 24, value: "At a glance", weight: 700 }));
  cy += 20;
  const gap = 12;
  const tileW = (inner - glancePad * 2 - gap * 4) / 5;
  edition.metrics.forEach((metric, index) => {
    counts.push(
      renderMetric(
        { ...metric, hint: clip(metric.hint, 18) },
        pad + glancePad + index * (tileW + gap),
        cy,
        tileW,
      ),
    );
  });
  cy += 130;
  const countsHeight = cy - countsTop + 10;
  y = countsTop + countsHeight + 28;

  footer.push(text({ x: pad, y, size: 14, value: edition.folio, font: MONO, fill: MUTED }));
  footer.push(text({ x: CARD_WIDTH - pad, y, size: 14, value: edition.weekday, font: MONO, fill: MUTED, anchor: "end" }));
  y += 36;

  const parts = [
    ...header,
    sectionChrome(pad, glanceTop, inner, glanceHeight),
    ...glance,
    sectionChrome(pad, countsTop, inner, countsHeight),
    ...counts,
    ...footer,
  ];

  const height = y + 8;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}">
  <defs>
    <radialGradient id="wash" cx="12%" cy="0%" r="70%">
      <stop offset="0%" stop-color="${AMBER}" stop-opacity="0.14"/>
      <stop offset="70%" stop-color="${BENCH}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="0.7" fill="#ffffff" opacity="0.045"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="${BENCH}"/>
  <rect width="100%" height="100%" fill="url(#wash)"/>
  <rect width="100%" height="100%" fill="url(#dots)"/>
  ${parts.join("\n  ")}
</svg>`;
  return { svg, width: CARD_WIDTH, height };
}

export function renderHealthDigestPng(edition: HealthDigestEdition): Buffer {
  const { svg, width } = renderHealthDigestSvg(edition);
  const fonts = digestFontFiles();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
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
  if (edition.allClear) return "Floor is clear.";
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
