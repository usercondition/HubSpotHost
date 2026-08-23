/**
 * Newspaper-style health-check card for Telegram.
 *
 * Renders a shop-floor edition as PNG so the ping reads like a digest
 * instead of a list of URLs. Buttons under the photo open the app.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import type { TrackerAssistantContext } from "./tracker-assistant";

const CARD_WIDTH = 1080;
const ISSUE_ORDER = ["no_plates", "costs_incomplete", "stale"] as const;

const FONT = "Liberation Serif, Noto Serif, DejaVu Serif, Times New Roman, serif";
const INK = "#1c1612";
const MUTED = "#6a6156";
const CRIMSON = "#7c1d1d";
const PAPER = "#f3ead8";
const BAND = "#ead9c0";

export type DigestSection = {
  key: string;
  kicker: string;
  hint: string;
  items: Array<{ name: string; stage: string }>;
  overflow: number;
};

export type HealthDigestEdition = {
  title: string;
  kicker: string;
  dateLine: string;
  weekday: string;
  issueLine: string;
  lede: string;
  deck: string;
  intakeLine: string | null;
  sections: DigestSection[];
  folio: string;
  allClear: boolean;
};

export function shopDigestTitle(raw?: string): string {
  return (raw?.trim() || "Print Ops").replace(/\s+[—-]\s+health check.*$/i, "").trim() || "Print Ops";
}

export function digestSectionMeta(issueKey: string): { kicker: string; hint: string; deck: (count: number) => string } {
  switch (issueKey) {
    case "no_plates":
      return {
        kicker: "Plates",
        hint: "Need a slice",
        deck: (count) => (count === 1 ? "1 without plates" : `${count} without plates`),
      };
    case "costs_incomplete":
      return {
        kicker: "Costs",
        hint: "Books still open",
        deck: (count) => (count === 1 ? "1 without costs" : `${count} without costs`),
      };
    case "stale":
      return {
        kicker: "Stale",
        hint: "Quiet for a week",
        deck: (count) => (count === 1 ? "1 gone quiet" : `${count} gone quiet`),
      };
    default:
      return {
        kicker: "Attention",
        hint: "Needs a look",
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

function localParts(now: Date, timeZone: string): { year: number; month: number; day: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    weekday: read("weekday"),
  };
}

function weekdayDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
}

function dayOfYear(now: Date, timeZone: string): number {
  const { year, month, day } = localParts(now, timeZone);
  const utc = Date.UTC(year, month - 1, day);
  const start = Date.UTC(year, 0, 1);
  return Math.floor((utc - start) / 86_400_000) + 1;
}

function nameLimitForWidth(width: number): number {
  if (width >= 800) return 42;
  if (width >= 400) return 26;
  return 18;
}

function shortStage(stage: string, limit: number): string {
  const cleaned = stage.replace(/\s+/g, " ").trim();
  if (/^queued to print$/i.test(cleaned)) return "Queued";
  if (/^ready to print$/i.test(cleaned)) return "Ready";
  return clip(cleaned, limit);
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
  const dateLine = weekdayDate(now, timeZone);

  const sections: DigestSection[] = [];
  const deckBits: string[] = [];
  for (const key of ISSUE_ORDER) {
    const rows = attention.filter((item) => item.issueKey === key);
    if (rows.length === 0) continue;
    const meta = digestSectionMeta(key);
    const widthGuess = attention.length >= 3 ? 300 : attention.length === 2 ? 460 : 900;
    const limit = widthGuess < 360 ? 28 : nameLimitForWidth(widthGuess);
    sections.push({
      key,
      kicker: meta.kicker,
      hint: meta.hint,
      items: rows.slice(0, 4).map((item) => ({
        name: clip(item.dealName, limit),
        stage: shortStage(item.stage, widthGuess >= 400 ? 18 : 16),
      })),
      overflow: Math.max(0, rows.length - 4),
    });
    deckBits.push(meta.deck(rows.length));
  }

  let intakeLine: string | null = null;
  if (pending > 0 || awaiting > 0) {
    const bits: string[] = [];
    if (pending > 0) bits.push(`${pending} waiting review`);
    if (awaiting > 0) bits.push(`${awaiting} buyer form${awaiting === 1 ? "" : "s"} open`);
    intakeLine = bits.join("  ·  ");
  }

  const lede = allClear
    ? "All quiet on the floor."
    : attention.length === 0
      ? "Intake needs you."
      : attention.length === 1
        ? "1 deal needs you."
        : `${attention.length} deals need you.`;

  const deck = allClear
    ? "Nothing waiting on plates, costs, or intake."
    : deckBits.join("  ·  ") || intakeLine || "Open items listed below.";

  return {
    title: shopDigestTitle(options?.title),
    kicker: "The Daily Floor",
    dateLine,
    weekday,
    issueLine: `Vol. I  ·  No. ${dayOfYear(now, timeZone)}`,
    lede,
    deck,
    intakeLine: attention.length > 0 ? intakeLine : null,
    sections,
    folio: `${snapshot.summary.activeOrders} job${snapshot.summary.activeOrders === 1 ? "" : "s"} on the floor`,
    allClear,
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
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/truetype/noto",
  ];
}

export function digestFontFiles(): string[] {
  const names = [
    "LiberationSerif-Regular.ttf",
    "LiberationSerif-Bold.ttf",
    "LiberationSerif-Italic.ttf",
    "DejaVuSerif.ttf",
    "DejaVuSerif-Bold.ttf",
    "NotoSerif-Regular.ttf",
    "NotoSerif-Bold.ttf",
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
  anchor?: "start" | "middle" | "end";
  weight?: 400 | 700;
  italic?: boolean;
  fill?: string;
  tracking?: number;
}): string {
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : "";
  const weight = opts.weight ? ` font-weight="${opts.weight}"` : "";
  const italic = opts.italic ? ` font-style="italic"` : "";
  const tracking = opts.tracking != null ? ` letter-spacing="${opts.tracking}"` : "";
  return `<text x="${opts.x}" y="${opts.y}" font-family="${FONT}" font-size="${opts.size}"${anchor}${weight}${italic} fill="${opts.fill || INK}"${tracking}>${escapeXml(opts.value)}</text>`;
}

function rule(x1: number, x2: number, y: number, width = 1): string {
  return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${INK}" stroke-width="${width}"/>`;
}

function doubleRule(x1: number, x2: number, y: number): { svg: string; height: number } {
  return {
    svg: `${rule(x1, x2, y, 2.4)}\n${rule(x1, x2, y + 5, 0.7)}`,
    height: 5,
  };
}

function sectionBlock(section: DigestSection, x: number, y: number, width: number): { svg: string; height: number } {
  const lines: string[] = [];
  let cursor = y;
  const showStage = width >= 360;
  lines.push(
    text({
      x,
      y: cursor,
      size: 18,
      value: section.kicker.toUpperCase(),
      weight: 700,
      fill: CRIMSON,
      tracking: 2.4,
    }),
  );
  cursor += 24;
  lines.push(text({ x, y: cursor, size: 17, value: section.hint, italic: true, fill: MUTED }));
  cursor += 12;
  lines.push(rule(x, x + width, cursor, 0.8));
  cursor += 30;
  for (const item of section.items) {
    lines.push(text({ x, y: cursor, size: 23, value: item.name, weight: 700 }));
    if (showStage && item.stage) {
      lines.push(
        text({
          x: x + width,
          y: cursor,
          size: 16,
          value: item.stage,
          anchor: "end",
          italic: true,
          fill: MUTED,
        }),
      );
    }
    cursor += 34;
  }
  if (section.overflow > 0) {
    lines.push(
      text({
        x,
        y: cursor,
        size: 17,
        value: `and ${section.overflow} more`,
        italic: true,
        fill: MUTED,
      }),
    );
    cursor += 26;
  }
  return { svg: lines.join("\n"), height: cursor - y };
}

function renderSectionGrid(
  sections: DigestSection[],
  x: number,
  y: number,
  totalWidth: number,
): { svg: string; height: number } {
  if (sections.length === 0) return { svg: "", height: 0 };
  const cols = Math.min(3, sections.length);
  const gap = 28;
  const colWidth = (totalWidth - gap * (cols - 1)) / cols;
  const blocks = sections.slice(0, cols).map((section, index) =>
    sectionBlock(section, x + index * (colWidth + gap), y, colWidth),
  );
  const height = Math.max(...blocks.map((block) => block.height));
  const gutters = blocks.slice(0, -1).map((_, index) => {
    const gx = x + (index + 1) * colWidth + index * gap + gap / 2;
    return `<line x1="${gx}" y1="${y - 4}" x2="${gx}" y2="${y + height}" stroke="${INK}" stroke-width="0.7"/>`;
  });
  return { svg: [...gutters, ...blocks.map((block) => block.svg)].join("\n"), height };
}

export function renderHealthDigestSvg(edition: HealthDigestEdition): { svg: string; width: number; height: number } {
  const pad = 72;
  const contentWidth = CARD_WIDTH - pad * 2;
  const parts: string[] = [];
  let y = 70;
  parts.push(rule(pad, CARD_WIDTH - pad, y, 0.8));
  y += 52;

  parts.push(
    text({
      x: CARD_WIDTH / 2,
      y,
      size: 52,
      value: edition.kicker.toUpperCase(),
      anchor: "middle",
      weight: 700,
      tracking: 3.5,
    }),
  );
  y += 34;
  parts.push(
    text({
      x: CARD_WIDTH / 2,
      y,
      size: 16,
      value: edition.title.toUpperCase(),
      anchor: "middle",
      fill: CRIMSON,
      tracking: 6,
    }),
  );
  y += 22;
  const mastheadRule = doubleRule(pad, CARD_WIDTH - pad, y);
  parts.push(mastheadRule.svg);
  y += 32;
  parts.push(text({ x: pad, y, size: 17, value: edition.issueLine, fill: MUTED }));
  parts.push(
    text({
      x: CARD_WIDTH / 2,
      y,
      size: 15,
      value: "HEALTH CHECK",
      anchor: "middle",
      weight: 700,
      fill: CRIMSON,
      tracking: 3.2,
    }),
  );
  parts.push(text({ x: CARD_WIDTH - pad, y, size: 17, value: edition.dateLine, anchor: "end", fill: MUTED }));
  y += 16;
  parts.push(rule(pad, CARD_WIDTH - pad, y, 1));
  y += 58;
  parts.push(text({ x: pad, y, size: 40, value: edition.lede, weight: 700 }));
  y += 34;
  parts.push(text({ x: pad, y, size: 22, value: edition.deck, italic: true, fill: MUTED }));
  y += 28;

  if (edition.intakeLine) {
    parts.push(`<rect x="${pad}" y="${y}" width="${contentWidth}" height="48" fill="${BAND}"/>`);
    parts.push(
      text({
        x: pad + 16,
        y: y + 31,
        size: 16,
        value: "INTAKE",
        weight: 700,
        fill: CRIMSON,
        tracking: 2.2,
      }),
    );
    parts.push(text({ x: pad + 112, y: y + 31, size: 20, value: edition.intakeLine }));
    y += 68;
  }

  if (edition.sections.length === 0) {
    y += 12;
    parts.push(
      text({
        x: CARD_WIDTH / 2,
        y,
        size: 24,
        value: edition.allClear ? "Nothing in the queue that needs a nudge." : "Open Intake to clear the desk.",
        anchor: "middle",
        italic: true,
        fill: MUTED,
      }),
    );
    y += 40;
  } else {
    const grid = renderSectionGrid(edition.sections, pad, y, contentWidth);
    parts.push(grid.svg);
    y += grid.height + 18;
  }

  const foot = doubleRule(pad, CARD_WIDTH - pad, y);
  parts.push(foot.svg);
  y += 34;
  parts.push(text({ x: pad, y, size: 17, value: edition.folio, fill: MUTED }));
  parts.push(
    text({
      x: CARD_WIDTH - pad,
      y,
      size: 17,
      value: `${edition.weekday} edition`,
      anchor: "end",
      fill: MUTED,
    }),
  );
  y += 36;

  const height = y + 22;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}">
  <rect width="100%" height="100%" fill="${PAPER}"/>
  <rect x="22" y="22" width="${CARD_WIDTH - 44}" height="${height - 44}" fill="none" stroke="${INK}" stroke-width="2.2"/>
  <rect x="30" y="30" width="${CARD_WIDTH - 60}" height="${height - 60}" fill="none" stroke="${INK}" stroke-width="0.7"/>
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
      defaultFontFamily: "Liberation Serif",
    },
    background: PAPER,
  });
  return Buffer.from(resvg.render().asPng());
}

export function healthDigestCaption(edition: HealthDigestEdition): string {
  if (edition.allClear) return `${edition.weekday} edition · all quiet on the floor.`;
  const bits = [edition.lede.replace(/\.$/, ""), edition.deck.replace(/\s+·\s+/g, " · ")];
  if (edition.intakeLine) bits.push(edition.intakeLine.replace(/\s+·\s+/g, " · "));
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
