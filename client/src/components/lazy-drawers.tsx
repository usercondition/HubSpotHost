/**
 * framer-motion (~90 KB gz) is only needed by the two overlay drawers. These wrappers load each drawer's
 * chunk the first time it opens, then keep it mounted so AnimatePresence exit animations still run.
 */
import { lazy, Suspense, useEffect, useState, type ComponentProps } from "react";

const DealOpsDrawerImpl = lazy(() => import("@/components/deal-ops-panel").then((m) => ({ default: m.DealOpsDrawer })));
const StackOrderDrawerImpl = lazy(() => import("@/components/stack-order-drawer").then((m) => ({ default: m.StackOrderDrawer })));

function useArmed(open: boolean): boolean {
  const [armed, setArmed] = useState(open);
  useEffect(() => {
    if (open) setArmed(true);
  }, [open]);
  return armed || open;
}

export function DealOpsDrawer(props: ComponentProps<typeof DealOpsDrawerImpl>) {
  const armed = useArmed(Boolean(props.dealId || props.offbook));
  if (!armed) return null;
  return (
    <Suspense fallback={null}>
      <DealOpsDrawerImpl {...props} />
    </Suspense>
  );
}

export function StackOrderDrawer(props: ComponentProps<typeof StackOrderDrawerImpl>) {
  const armed = useArmed(props.row != null);
  if (!armed) return null;
  return (
    <Suspense fallback={null}>
      <StackOrderDrawerImpl {...props} />
    </Suspense>
  );
}
