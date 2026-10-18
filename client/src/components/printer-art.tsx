/**
 * Hand-drawn SVG printer illustrations for the Printers page.
 *
 * Original artwork made for Print Ops (no photos, no third-party images, no
 * hotlinks), so there is nothing to license. Shapes are simplified "product
 * style" drawings of each model family: Phrozen Sonic Mighty (amber lid),
 * Phrozen Sonic Mega 8K S (big amber lid), HeyGears UltraCraft Reflex (white
 * body, smoked lid). When printing, the build plate bobs and the UV glows;
 * motion stops under prefers-reduced-motion.
 */
import { useId } from "react";
import type { PrinterArt as Art } from "@shared/printer-status";

type Props = { art: Art; printing: boolean; className?: string; title?: string };

type Shape = {
  w: number; // body width
  lidH: number; // lid height
  baseH: number; // base height
  lid: [string, string]; // gradient stops
  lidStroke: string;
  body: string;
  bodyStroke: string;
  screen: string;
};

const SHAPES: Record<Art, Shape> = {
  "phrozen-mighty": { w: 70, lidH: 72, baseH: 30, lid: ["#fbbf24", "#d97706"], lidStroke: "#f59e0b", body: "#292524", bodyStroke: "#44403c", screen: "#0ea5e9" },
  "phrozen-mega": { w: 92, lidH: 82, baseH: 30, lid: ["#fbbf24", "#c2410c"], lidStroke: "#f59e0b", body: "#292524", bodyStroke: "#44403c", screen: "#0ea5e9" },
  "heygears-reflex": { w: 80, lidH: 70, baseH: 34, lid: ["#78716c", "#292524"], lidStroke: "#a8a29e", body: "#e7e5e4", bodyStroke: "#d6d3d1", screen: "#22d3ee" },
  generic: { w: 76, lidH: 72, baseH: 30, lid: ["#a8a29e", "#57534e"], lidStroke: "#a8a29e", body: "#292524", bodyStroke: "#44403c", screen: "#0ea5e9" },
};

export function PrinterArt({ art, printing, className, title }: Props) {
  const uid = useId().replace(/:/g, "");
  const s = SHAPES[art] ?? SHAPES.generic;
  const W = 120;
  const H = 140;
  const x0 = (W - s.w) / 2;
  const baseY = H - 12 - s.baseH; // top of base
  const lidY = baseY - s.lidH; // top of lid
  const vatY = baseY - 9;
  const plateW = s.w * 0.56;
  const plateX = (W - plateW) / 2;
  const plateY = printing ? vatY - 20 : lidY + 12; // idle: parked high
  const rounded = art === "heygears-reflex" ? 10 : 6;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      role="img"
      aria-label={title ?? "Printer illustration"}
      data-art={art}
      data-printing={printing ? "1" : "0"}
    >
      <defs>
        <linearGradient id={`lid-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={s.lid[0]} stopOpacity="0.85" />
          <stop offset="1" stopColor={s.lid[1]} stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id={`shine-${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`uv-${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#c084fc" stopOpacity="0.95" />
          <stop offset="1" stopColor="#7c3aed" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`plate-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f5f5f4" />
          <stop offset="1" stopColor="#a8a29e" />
        </linearGradient>
      </defs>

      {/* floor shadow */}
      <ellipse cx={W / 2} cy={H - 8} rx={s.w / 2 + 6} ry="4" fill="#000" opacity="0.28" />

      {/* base */}
      <rect x={x0} y={baseY} width={s.w} height={s.baseH} rx={rounded / 2} fill={s.body} stroke={s.bodyStroke} strokeWidth="1.5" />
      {/* touch screen */}
      <rect x={x0 + s.w - 26} y={baseY + 8} width="18" height="12" rx="2" fill="#0c0a09" />
      <rect x={x0 + s.w - 24} y={baseY + 10} width="14" height="8" rx="1" fill={s.screen} className={printing ? "pa-screen" : undefined} opacity={printing ? 0.95 : 0.35} />
      {/* brand stripe */}
      <rect x={x0 + 8} y={baseY + 12} width={s.w * 0.32} height="3" rx="1.5" fill={art === "heygears-reflex" ? "#a8a29e" : "#f59e0b"} opacity="0.85" />

      {/* UV glow under the vat */}
      {printing ? <ellipse className="pa-uv" cx={W / 2} cy={vatY + 6} rx={plateW / 2 + 6} ry="6" fill={`url(#uv-${uid})`} /> : null}

      {/* resin vat */}
      <rect x={plateX - 6} y={vatY} width={plateW + 12} height="9" rx="2" fill="#57534e" stroke="#78716c" strokeWidth="1" />
      <rect x={plateX - 3} y={vatY + 2} width={plateW + 6} height="4" rx="1" fill={printing ? "#a78bfa" : "#78716c"} opacity="0.75" />

      {/* Z rail behind the plate */}
      <rect x={W / 2 + plateW / 2 - 2} y={lidY + 6} width="4" height={vatY - lidY - 6} rx="2" fill="#78716c" />

      {/* build plate + arm (bobs while printing) */}
      <g className={printing ? "pa-plate" : undefined}>
        <rect x={W / 2 - 2} y={plateY - 10} width="4" height="10" fill="#a8a29e" />
        <rect x={W / 2} y={plateY - 12} width={plateW / 2} height="4" rx="1.5" fill="#a8a29e" />
        <rect x={plateX} y={plateY} width={plateW} height="6" rx="1.5" fill={`url(#plate-${uid})`} />
        {printing ? (
          // a little model growing under the plate (upside down, like resin)
          <g fill="#fbbf24">
            <rect className="pa-model" x={W / 2 - 7} y={plateY + 6} width="14" height="9" rx="2" opacity="0.9" />
            <rect x={W / 2 - 13} y={plateY + 6} width="3" height="6" rx="1" opacity="0.7" />
            <rect x={W / 2 + 10} y={plateY + 6} width="3" height="6" rx="1" opacity="0.7" />
          </g>
        ) : null}
      </g>

      {/* lid */}
      <rect x={x0 + 2} y={lidY} width={s.w - 4} height={s.lidH} rx={rounded} fill={`url(#lid-${uid})`} stroke={s.lidStroke} strokeWidth="1.5" />
      <rect x={x0 + 8} y={lidY + 6} width="8" height={s.lidH - 14} rx="4" fill={`url(#shine-${uid})`} />
      {art === "heygears-reflex" ? <rect x={x0 + 2} y={lidY + s.lidH - 8} width={s.w - 4} height="8" fill={s.body} opacity="0.9" /> : null}

      {/* idle: little zzz */}
      {!printing ? (
        <g className="pa-zzz" fill="#a8a29e" fontFamily="ui-sans-serif, system-ui" fontWeight="700">
          <text x={x0 + s.w - 6} y={lidY - 4} fontSize="11">z</text>
          <text x={x0 + s.w + 2} y={lidY - 12} fontSize="8">z</text>
        </g>
      ) : (
        <g className="pa-spark" fill="#fde68a">
          <circle cx={x0 + s.w + 2} cy={lidY + 6} r="2" />
          <circle cx={x0 - 3} cy={lidY + 22} r="1.5" />
        </g>
      )}
    </svg>
  );
}
