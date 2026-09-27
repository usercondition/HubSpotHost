import { lazy, Suspense } from "react";
import { Switch, Route, Router } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { useAppHashLocation } from "./lib/hash-location";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell, ThemeProvider } from "@/components/shell";
import { OwnerSessionProvider } from "@/hooks/use-owner-session";
import Dashboard from "@/pages/dashboard";
import DealsPage from "@/pages/deals";
import Operations from "@/pages/operations";
import Setup from "@/pages/setup";
import PaidOrders from "@/pages/paid-orders";
import MarketplaceBriefPage from "@/pages/marketplace-brief";
import OrderLinks from "@/pages/order-links";
import Expenses from "@/pages/expenses";
const Performance = lazy(() => import("@/pages/performance"));
function PerformanceRoute() {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading Stats…</div>}><Performance /></Suspense>;
}
import Supplies from "@/pages/supplies";
import Prints from "@/pages/prints";
import PlateLibraryPage from "@/pages/plate-library";
import PrintersPage from "@/pages/printers";
import ResinInventoryPage from "@/pages/resin-inventory";
import ShippingLabelsPage from "@/pages/shipping-labels";
import ProductionQueuePage from "@/pages/queue";
import PriorityStackPage from "@/pages/priority-stack";
import ClientsPage from "@/pages/clients";
import ClientOrder from "@/pages/client-order";
import FloorFocusPage from "@/pages/floor-focus";
import NotFound from "@/pages/not-found";

/** Owner-facing routes live inside the operations shell. */
function ShellRoutes() {
  return (
    <OwnerSessionProvider>
      <AppShell>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/stack" component={PriorityStackPage} />
          <Route path="/focus/:kind" component={FloorFocusPage} />
          <Route path="/focus" component={FloorFocusPage} />
          <Route path="/queue" component={ProductionQueuePage} />
          <Route path="/labels" component={ShippingLabelsPage} />
          <Route path="/deals" component={DealsPage} />
          {/* Clients + Marketplace Brief stay routed but off the nav rail (declutter). */}
          <Route path="/clients" component={ClientsPage} />
          <Route path="/orders" component={OrderLinks} />
          <Route path="/expenses" component={Expenses} />
          <Route path="/operations" component={Operations} />
          <Route path="/paid-orders" component={PaidOrders} />
          <Route path="/marketplace-brief" component={MarketplaceBriefPage} />
          <Route path="/supplies" component={Supplies} />
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
          <Route path="/performance" component={PerformanceRoute} />
          <Route path="/setup" component={Setup} />
          <Route component={NotFound} />
        </Switch>
      </AppShell>
    </OwnerSessionProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useAppHashLocation}>
            <Switch>
              {/* Public buyer form. Legacy /client-order path still works. */}
              <Route path="/order-form/:token" component={ClientOrder} />
              <Route path="/client-order/:token" component={ClientOrder} />
              <Route component={ShellRoutes} />
            </Switch>
          </Router>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
