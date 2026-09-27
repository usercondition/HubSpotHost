import { useEffect, type ReactNode } from "react";

/**
 * Route container inside the shell. Keeping one mounted page avoids retaining
 * stale routes when a lazy page suspends during navigation.
 */
export function PageTransition({
  routeKey,
  children,
}: {
  routeKey: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const pane = document.querySelector<HTMLElement>("[data-scroll-pane]");
    if (pane) pane.scrollTop = 0;
  }, [routeKey]);

  return (
    <div key={routeKey} className="page-motion min-h-full" data-testid="page-transition">{children}</div>
  );
}
