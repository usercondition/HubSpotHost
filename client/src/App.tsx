import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell, ThemeProvider } from "@/components/shell";
import Dashboard from "@/pages/dashboard";
import Operations from "@/pages/operations";
import Setup from "@/pages/setup";
import PaidOrders from "@/pages/paid-orders";
import OrderLinks from "@/pages/order-links";
import ClientOrder from "@/pages/client-order";
import NotFound from "@/pages/not-found";

/** Owner-facing routes live inside the operations shell. */
function ShellRoutes() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/orders" component={OrderLinks} />
        <Route path="/operations" component={Operations} />
        <Route path="/paid-orders" component={PaidOrders} />
        <Route path="/setup" component={Setup} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <Switch>
              {/* Public, buyer-facing. Deliberately outside the owner shell. */}
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
