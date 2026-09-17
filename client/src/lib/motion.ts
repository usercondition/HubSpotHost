/**
 * Shared Print Ops motion — fast, soft, shop-floor calm.
 * Prefer opacity + small translate; avoid blur, bounce, or glow.
 */
import type { Transition, Variants } from "framer-motion";

export const MOTION = {
  /** Hover / active chrome */
  fastMs: 140,
  /** Page + panel enter */
  pageMs: 180,
  /** Drawer / sheet */
  drawerMs: 220,
  /** Max list stagger total */
  staggerMs: 28,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
  easeOut: [0.16, 1, 0.3, 1] as [number, number, number, number],
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const pageTransition: Transition = {
  duration: MOTION.pageMs / 1000,
  ease: MOTION.easeOut,
};

export const pageVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  enter: { opacity: 1, y: 0, transition: pageTransition },
  exit: {
    opacity: 0,
    y: -2,
    transition: { duration: 0.1, ease: MOTION.ease },
  },
};

export const drawerTransition: Transition = {
  duration: MOTION.drawerMs / 1000,
  ease: MOTION.easeOut,
};

export const drawerPanelVariants: Variants = {
  initial: { x: "100%", opacity: 0.85 },
  enter: { x: 0, opacity: 1, transition: drawerTransition },
  exit: {
    x: "100%",
    opacity: 0.9,
    transition: { duration: 0.16, ease: MOTION.ease },
  },
};

export const drawerScrimVariants: Variants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: 0.16 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

export const reducedPageVariants: Variants = {
  initial: { opacity: 1 },
  enter: { opacity: 1 },
  exit: { opacity: 1 },
};
