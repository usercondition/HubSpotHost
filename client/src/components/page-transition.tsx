import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { pageVariants, reducedPageVariants } from "@/lib/motion";

/**
 * Soft page crossfade inside the shell main pane.
 * Opacity only — never transform the scroll root (that tears while scrolling).
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
  const [settled, setSettled] = useState(true);

  useEffect(() => {
    setSettled(Boolean(reduce));
    const pane = document.querySelector<HTMLElement>("[data-scroll-pane]");
    if (pane) pane.scrollTop = 0;
  }, [routeKey, reduce]);

  return (
    <AnimatePresence mode="sync" initial={false}>
      <motion.div
        key={routeKey}
        className="page-motion min-h-full"
        variants={variants}
        initial="initial"
        animate="enter"
        exit="exit"
        style={reduce || settled ? undefined : { willChange: "opacity" }}
        onAnimationComplete={(definition) => {
          if (definition === "enter") setSettled(true);
        }}
        data-testid="page-transition"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
