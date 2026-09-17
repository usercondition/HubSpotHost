import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { pageVariants, reducedPageVariants } from "@/lib/motion";

/**
 * Soft page enter/exit inside the shell main pane.
 * Shell chrome (rail + top bar) stays still; only workspace content moves.
 */
export function PageTransition({
  routeKey,
  children,
}: {
  routeKey: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const variants = reduce ? reducedPageVariants : pageVariants;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={routeKey}
        className="page-motion min-h-full"
        variants={variants}
        initial="initial"
        animate="enter"
        exit="exit"
        data-testid="page-transition"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
