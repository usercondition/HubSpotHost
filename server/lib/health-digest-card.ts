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
  lede: string;
  deck: string;
  intakeLine: string | null;
  sections: DigestSection[];
  folio: string;
  allClear: boolean;
};

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

function weekdayDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
}

function sectionMeta(issueKey: string): { kicker: string; hint: string } {
  switch (issueKey) {
    case "no_plates":
      return { kicker: "Plates", hint: "Attach sliced files before print" };
    case "costs_incomplete":
      return { kicker: "Costs", hint: "Add material, labor, pack, and ship" };
    case "stale":
      return { kicker: "Stale", hint: "No HubSpot update in 7+ days" };
    default:
      return { kicker: "Attention", hint: "Needs a look" };
  }
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
  const dateLine = weekdayDate(now, timeZone);

  const needBits: string[] = [];
  if (pending > 0) needBits.push(`${pending} to review`);
  if (awaiting > 0) needBits.push(`${awaiting} awaiting buyer`);
  const lede = allClear
    ? "All quiet on the floor."
    : attention.length === 0
      ? "Intake needs you."
      : attention.length === 1
        ? "1 deal needs you."
        : `${attention.length} deals need you.`;

  const sections: DigestSection[] = [];
  for (const key of ISSUE_ORDER) {
    const rows = attention.filter((item) => item.issueKey === key);
    if (rows.length === 0) continue;
    const meta = sectionMeta(key);
    sections.push({
      key,
      kicker: meta.kicker,
      hint: meta.hint,
      items: rows.slice(0, 5).map((item) => ({
        name: clip(item.dealName, 36),
        stage: clip(item.stage, 22),
      })),
      overflow: Math.max(0, rows.length - 5),
    });
  }

  let intakeLine: string | null = null;
  if (pending > 0 || awaiting > 0) {
    const bits: string[] = [];
    if (pending > 0) bits.push(`${pending} paid order${pending === 1 ? "" : "s"} waiting review`);
    if (awaiting > 0) bits.push(`${awaiting} buyer form${awaiting === 1 ? "" : "s"} still open`);
    intakeLine = bits.join(" · ");
  }

  return {
    title: options?.title?.trim() || "Print Ops",
    kicker: "The Daily Floor",
    dateLine,
    lede,
    deck: allClear
      ? "No missing plates, incomplete costs, stale deals, or stuck intake."
      : needBits.join(" · ") || "Open items listed below.",
    intakeLine,
    sections,
    folio: `${snapshot.summary.activeOrders} active · ${snapshot.summary.attentionCount} attention`,
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

function firstExisting(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path));
}

export function digestFontFiles(): string[] {
  const dirs = fontSearchDirs();
  const names = [
    "LiberationSerif-Regular.ttf",
    "LiberationSerif-Bold.ttf",
    "DejaVuSerif.ttf",
    "DejaVuSerif-Bold.ttf",
    "NotoSerif-Regular.ttf",
    "NotoSerif-Bold.ttf",
  ];
  return firstExisting(dirs.flatMap((dir) => names.map((name) => join(dir, name))));
}

function sectionBlock(section: DigestSection, x: number, y: number, width: number): { svg: string; height: number } {
  const lines: string[] = [];
  let cursor = y;
  lines.push(
    `<text x="${x}" y="${cursor}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="22" font-weight="700" letter-spacing="3" fill="#8b1e1e">${escapeXml(section.kicker.toUpperCase())}</text>`,
  );
  cursor += 28;
  lines.push(
    `<text x="${x}" y="${cursor}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="20" font-style="italic" fill="#5c564c">${escapeXml(section.hint)}</text>`,
  );
  cursor += 18;
  lines.push(`<line x1="${x}" y1="${cursor}" x2="${x + width}" y2="${cursor}" stroke="#1a1714" stroke-width="1"/>`);
  cursor += 34;
  for (const item of section.items) {
    lines.push(
      `<text x="${x}" y="${cursor}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="26" fill="#1a1714">${escapeXml(item.name)}</text>`,
    );
    cursor += 28;
    if (item.stage) {
      lines.push(
        `<text x="${x}" y="${cursor}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="20" fill="#5c564c">${escapeXml(item.stage)}</text>`,
      );
      cursor += 30;
    } else {
      cursor += 8;
    }
  }
  if (section.overflow > 0) {
    lines.push(
      `<text x="${x}" y="${cursor}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="20" font-style="italic" fill="#5c564c">and ${section.overflow} more in the shop</text>`,
    );
    cursor += 28;
  }
  return { svg: lines.join("\n"), height: cursor - y + 8 };
}

export function renderHealthDigestSvg(edition: HealthDigestEdition): { svg: string; width: number; height: number } {
  const pad = 64;
  const contentWidth = CARD_WIDTH - pad * 2;
  const parts: string[] = [];
  let y = 78;

  parts.push(
    `<text x="${CARD_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="20" letter-spacing="8" fill="#8b1e1e">${escapeXml(edition.kicker.toUpperCase())}</text>`,
  );
  y += 62;
  parts.push(
    `<text x="${CARD_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="72" font-weight="700" fill="#1a1714">${escapeXml(edition.title.toUpperCase())}</text>`,
  );
  y += 28;
  parts.push(`<line x1="${pad}" y1="${y}" x2="${CARD_WIDTH - pad}" y2="${y}" stroke="#1a1714" stroke-width="3"/>`);
  y += 36;
  parts.push(
    `<text x="${CARD_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="24" fill="#1a1714">Health Check  ·  ${escapeXml(edition.dateLine)}</text>`,
  );
  y += 18;
  parts.push(`<line x1="${pad}" y1="${y}" x2="${CARD_WIDTH - pad}" y2="${y}" stroke="#1a1714" stroke-width="1.5"/>`);
  y += 70;
  parts.push(
    `<text x="${pad}" y="${y}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="44" font-weight="700" fill="#1a1714">${escapeXml(edition.lede)}</text>`,
  );
  y += 40;
  parts.push(
    `<text x="${pad}" y="${y}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="24" fill="#5c564c">${escapeXml(edition.deck)}</text>`,
  );
  y += 36;

  if (edition.intakeLine) {
    parts.push(`<rect x="${pad}" y="${y}" width="${contentWidth}" height="56" fill="#efe6d6"/>`);
    parts.push(
      `<text x="${pad + 18}" y="${y + 36}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="22" fill="#1a1714"><tspan font-weight="700" fill="#8b1e1e">INTAKE</tspan>   ${escapeXml(edition.intakeLine)}</text>`,
    );
    y += 80;
  }

  if (edition.sections.length === 0 && edition.allClear) {
    y += 24;
    parts.push(
      `<text x="${CARD_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="28" font-style="italic" fill="#5c564c">Nothing in the queue that needs a nudge.</text>`,
    );
    y += 48;
  } else if (edition.sections.length === 1) {
    const block = sectionBlock(edition.sections[0]!, pad, y, contentWidth);
    parts.push(block.svg);
    y += block.height + 16;
  } else if (edition.sections.length >= 2) {
    const colGap = 40;
    const colWidth = (contentWidth - colGap) / 2;
    const left = sectionBlock(edition.sections[0]!, pad, y, colWidth);
    const right = sectionBlock(edition.sections[1]!, pad + colWidth + colGap, y, colWidth);
    parts.push(`<line x1="${pad + colWidth + colGap / 2}" y1="${y - 8}" x2="${pad + colWidth + colGap / 2}" y2="${y + Math.max(left.height, right.height)}" stroke="#1a1714" stroke-width="1"/>`);
    parts.push(left.svg, right.svg);
    y += Math.max(left.height, right.height) + 28;
    if (edition.sections[2]) {
      parts.push(`<line x1="${pad}" y1="${y}" x2="${CARD_WIDTH - pad}" y2="${y}" stroke="#1a1714" stroke-width="1"/>`);
      y += 36;
      const third = sectionBlock(edition.sections[2], pad, y, contentWidth);
      parts.push(third.svg);
      y += third.height + 16;
    }
  }

  y += 12;
  parts.push(`<line x1="${pad}" y1="${y}" x2="${CARD_WIDTH - pad}" y2="${y}" stroke="#1a1714" stroke-width="3"/>`);
  y += 36;
  parts.push(
    `<text x="${pad}" y="${y}" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="20" fill="#5c564c">${escapeXml(edition.folio)}</text>`,
  );
  parts.push(
    `<text x="${CARD_WIDTH - pad}" y="${y}" text-anchor="end" font-family="Liberation Serif, Noto Serif, DejaVu Serif, serif" font-size="20" fill="#5c564c">Shop edition</text>`,
  );
  y += 56;

  const height = Math.max(900, y + 8);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}">
  <rect width="100%" height="100%" fill="#f4efe4"/>
  <rect x="28" y="28" width="${CARD_WIDTH - 56}" height="${height - 56}" fill="none" stroke="#1a1714" stroke-width="2"/>
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
    background: "#f4efe4",
  });
  return Buffer.from(resvg.render().asPng());
}

export function healthDigestCaption(edition: HealthDigestEdition): string {
  if (edition.allClear) return `${edition.dateLine.split(",")[0]} edition · all quiet on the floor.`;
  return `${edition.lede} ${edition.deck}`.trim();
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
