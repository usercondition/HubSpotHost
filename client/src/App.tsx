import { Suspense } from "react";
import { lazyPage, PageFallback } from "@/lib/lazy-page";
import { Switch, Route, Router } from "wouter";
import { NERVE_SECTION_ENABLED } from "@/lib/nerve";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { useAppHashLocation } from "./lib/hash-location";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell, MorePage, ThemeProvider } from "@/components/shell";
import { OwnerSessionProvider } from "@/hooks/use-owner-session";
const NervePage = lazyPage(() => import("@/pages/nerve"));
const Dashboard = lazyPage(() => import("@/pages/dashboard"));
const DealsPage = lazyPage(() => import("@/pages/deals"));
const Operations = lazyPage(() => import("@/pages/operations"));
const Setup = lazyPage(() => import("@/pages/setup"));
const PaidOrders = lazyPage(() => import("@/pages/paid-orders"));
const MarketplaceBriefPage = lazyPage(() => import("@/pages/marketplace-brief"));
const InboxPage = lazyPage(() => import("@/pages/inbox"));
const FilesPage = lazyPage(() => import("@/pages/files"));
const OrderLinks = lazyPage(() => import("@/pages/order-links"));
const QuotePage = lazyPage(() => import("@/pages/quote"));
const Performance = lazyPage(() => import("@/pages/performance"));
const Spending = lazyPage(() => import("@/pages/spending"));
const Prints = lazyPage(() => import("@/pages/prints"));
const PlateLibraryPage = lazyPage(() => import("@/pages/plate-library"));
const PrintersPage = lazyPage(() => import("@/pages/printers"));
const ResinInventoryPage = lazyPage(() => import("@/pages/resin-inventory"));
const ShippingLabelsPage = lazyPage(() => import("@/pages/shipping-labels"));
const ShipmentsPage = lazyPage(() => import("@/pages/shipments"));
const ProductionQueuePage = lazyPage(() => import("@/pages/queue"));
const PriorityStackPage = lazyPage(() => import("@/pages/priority-stack"));
const ClientsPage = lazyPage(() => import("@/pages/clients"));
const ClientOrder = lazyPage(() => import("@/pages/client-order"));
const FloorFocusPage = lazyPage(() => import("@/pages/floor-focus"));
const NotFound = lazyPage(() => import("@/pages/not-found"));

/** Owner-facing routes live inside the operations shell. */
function ShellRoutes() {
  return (
    <AppShell>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/stack" component={PriorityStackPage} />
          <Route path="/focus/:kind" component={FloorFocusPage} />
          <Route path="/focus" component={FloorFocusPage} />
          <Route path="/queue" component={ProductionQueuePage} />
          <Route path="/labels" component={ShippingLabelsPage} />
          <Route path="/shipments" component={ShipmentsPage} />
          <Route path="/deals" component={DealsPage} />
          {/* Clients + Marketplace Brief stay routed but off the nav rail (declutter). */}
          <Route path="/clients" component={ClientsPage} />
          <Route path="/orders" component={OrderLinks} />
          <Route path="/quote" component={QuotePage} />
          <Route path="/expenses" component={Spending} />
          <Route path="/spending/overhead" component={Spending} />
          <Route path="/spending" component={Spending} />
          <Route path="/operations" component={Operations} />
          <Route path="/paid-orders" component={PaidOrders} />
          <Route path="/marketplace-brief" component={MarketplaceBriefPage} />
          <Route path="/inbox" component={InboxPage} />
          <Route path="/files" component={FilesPage} />
          <Route path="/supplies" component={Spending} />
          <Route path="/prints" component={Prints} />
          <Route path="/library" component={PlateLibraryPage} />
          <Route path="/printers" component={PrintersPage} />
          <Route path="/resin" component={ResinInventoryPage} />
          {/*
            Kits UI parked: live parts/QC is Orders Parts + Prints plate bits.
            Keep kit-dry-run.tsx /api/kits for a later thin rebuild; do not re-add
            the route until attach uses the same Slice.log + printer + bits path.
          */}
          {/* Focus shortcuts redirect to workspaces; Floor chips skip the intermediate list. */}
          <Route path="/performance" component={Performance} />
          <Route path="/setup" component={Setup} />
          {/* Phone More page (own route, not an overlay). Desktop redirects to the Work hub. */}
          <Route path="/more" component={MorePage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
      </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          {/* One owner session for Print Ops and Nerve: Nerve unlocks with the same Print Ops key. */}
          <OwnerSessionProvider>
          <Router hook={useAppHashLocation}>
            <Suspense fallback={<PageFallback />}>
            <Switch>
              {/* Public buyer form. Legacy /client-order path still works. */}
              <Route path="/order-form/:token" component={ClientOrder} />
              <Route path="/client-order/:token" component={ClientOrder} />
              {/* Nerve: full-window takeover with its own shell (flag off by default). */}
              {NERVE_SECTION_ENABLED ? <Route path="/nerve/:tab/:sub" component={NervePage} /> : null}
              {NERVE_SECTION_ENABLED ? <Route path="/nerve/:tab" component={NervePage} /> : null}
              {NERVE_SECTION_ENABLED ? <Route path="/nerve" component={NervePage} /> : null}
              <Route component={ShellRoutes} />
            </Switch>
            </Suspense>
          </Router>
          </OwnerSessionProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
