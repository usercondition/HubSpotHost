/**
 * Shared Print Ops motion — calm crossfades, no scroll-root transforms.
 * Transform only on overlays (drawers); page content uses opacity.
 */
import type { Transition, Variants } from "framer-motion";

export const MOTION = {
  fastMs: 120,
  pageMs: 200,
  drawerMs: 280,
  staggerMs: 40,
  /** Slightly heavy ease — less “toy UI”, more product. */
  ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number],
  easeOut: [0.16, 1, 0.3, 1] as [number, number, number, number],
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const pageTransition: Transition = {
  duration: MOTION.pageMs / 1000,
  ease: MOTION.ease,
};

/** Opacity-only so the scroll pane never carries a transform layer. */
export const pageVariants: Variants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: pageTransition },
  exit: { opacity: 0, transition: { duration: 0.12, ease: MOTION.ease } },
};

export const drawerTransition: Transition = {
  duration: MOTION.drawerMs / 1000,
  ease: MOTION.easeOut,
};

export const drawerPanelVariants: Variants = {
  initial: { x: "100%" },
  enter: { x: 0, transition: drawerTransition },
  exit: { x: "100%", transition: { duration: 0.2, ease: MOTION.ease } },
};

export const drawerScrimVariants: Variants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: 0.2, ease: MOTION.ease } },
  exit: { opacity: 0, transition: { duration: 0.15, ease: MOTION.ease } },
};

export const reducedPageVariants: Variants = {
  initial: { opacity: 1 },
  enter: { opacity: 1 },
  exit: { opacity: 1 },
};
