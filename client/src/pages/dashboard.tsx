import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ListChecks, ListOrdered, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrintOpsHome } from "@/components/print-ops-home";
import { PageHeader } from "@/components/shell";
import { pacificDayLabel } from "@/lib/stage-chip";
import type { HealthResponse } from "@shared/schema";

function SystemStatusPill({ health }: { health: HealthResponse | undefined }) {
  if (!health) return null;
  const live = health.safety.liveWriteReady === true;
  const signing = health.webhook.verification === "configured";
  const storageWarn = health.storage?.warning;
  if (live && signing && !storageWarn) return null;

  return (
    <Link
      href="/setup"
      data-testid="panel-system-status"
      className="inline-flex items-center gap-1.5 rounded-md border border-warn/40 bg-warn/15 px-2.5 py-1 text-sm font-medium text-warn hover:bg-warn/20"
      title={storageWarn || "HubSpot writes or webhook need a quick check"}
    >
      <SlidersHorizontal className="h-3 w-3" />
      Setup
    </Link>
  );
}

export default function Dashboard() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });

  return (
    <div className="mx-auto flex w-full max-w-[1208px] flex-col" data-testid="page-floor">
      <PageHeader
        title="Print Ops"
        subtitle={`Needs you, orders, tracking, and systems · ${pacificDayLabel()}`}
        hideActionsOnPhone
        actions={
          <>
            <SystemStatusPill health={health.data} />
            <Button asChild size="sm" variant="outline" className="h-8">
              <Link href="/stack">
                <ListChecks className="h-3.5 w-3.5" />
                Stack
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline" className="h-8" data-testid="link-floor-open-queue">
              <Link href="/queue">
                <ListOrdered className="h-3.5 w-3.5" />
                Queue
              </Link>
            </Button>
          </>
        }
      />
      <div className="page-stack">
        <PrintOpsHome />
      </div>
    </div>
  );
}
