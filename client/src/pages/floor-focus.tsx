/**
 * Temporary Floor focus lists — reached from pressure-chip shortcuts.
 * Not in the nav rail; deep-link only (`/#/focus/plates`).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FileUp,
  Link2,
  ListOrdered,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import {
  attentionNextStep,
  floorFocusHref,
  floorFocusMeta,
  isFloorFocusKind,
  readHashQueryParam,
  type FloorFocusKind,
} from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { StatusPill, WorkspaceSection } from "@/components/primitives";
import type { PerformanceResponse } from "@shared/schema";

const KIND_ORDER: FloorFocusKind[] = ["plates", "costs", "stale", "intake", "buyer"];

function useFocusKind(): FloorFocusKind {
  const [, params] = useRoute("/focus/:kind");
  if (isFloorFocusKind(params?.kind)) return params.kind;
  // Legacy `#/focus?kind=plates` (and stock-wouter search fallback).
  const fromQuery = readHashQueryParam("kind");
  if (isFloorFocusKind(fromQuery)) return fromQuery;
  return "plates";
}

export default function FloorFocusPage() {
  const kind = useFocusKind();
  const meta = floorFocusMeta(kind);

  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Focus unlocked",
    successDescription: "Same Daily Work session as Floor and Queue.",
  });

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const rows = useMemo(() => {
    if (!performance.data || !meta.issueKey) return [];
    return (performance.data.attention ?? []).filter((item) => item.issueKey === meta.issueKey);
  }, [performance.data, meta.issueKey]);

  const intakeCount =
    kind === "intake"
      ? performance.data?.intake.pendingReview ?? 0
      : kind === "buyer"
        ? performance.data?.intake.awaitingClient ?? 0
        : 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={meta.title}
        subtitle={meta.description}
        actions={
          <Button asChild size="sm" variant="outline" data-testid="button-focus-back-floor">
            <Link href="/">
              <ArrowLeft className="mr-2 h-3.5 w-3.5" />
              Floor
            </Link>
          </Button>
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title={`Unlock ${meta.title.toLowerCase()}`}
            description="Owner code required to load this shortcut list."
            buttonLabel="Unlock"
            testIdPrefix="focus"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5" data-testid="panel-focus-kind-switcher">
              {KIND_ORDER.map((option) => {
                const active = option === kind;
                return (
                  <Button
                    key={option}
                    asChild
                    size="sm"
                    variant={active ? "default" : "outline"}
                    data-testid={`button-focus-kind-${option}`}
                  >
                    <Link href={floorFocusHref(option)}>{floorFocusMeta(option).title}</Link>
                  </Button>
                );
              })}
            </div>

            {performance.isLoading ? (
              <Skeleton className="h-40 rounded-lg" data-testid="skeleton-floor-focus" />
            ) : performance.isError || !performance.data ? (
              <WorkspaceSection title="Could not load focus list" testId="panel-focus-error">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
                  <Button size="sm" onClick={() => performance.refetch()}>
                    {performance.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    Try again
                  </Button>
                </div>
              </WorkspaceSection>
            ) : meta.issueKey ? (
              <WorkspaceSection
                eyebrow="Shortcut"
                title={`${rows.length} order${rows.length === 1 ? "" : "s"}`}
                description={meta.description}
                actions={
                  <Button asChild size="sm" variant="outline" data-testid="button-focus-open-workspace">
                    <Link href={meta.workspaceHref}>{meta.workspaceLabel}</Link>
                  </Button>
                }
                testId="panel-focus-deal-list"
              >
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-focus-empty">
                    Nothing in this bucket right now. You’re clear.
                  </p>
                ) : (
                  <div className="glance-list">
                    {rows.map((item, index) => {
                      const step = attentionNextStep({
                        dealId: item.dealId,
                        issue: item.issue,
                        portalId: performance.data.hubspotPortalId,
                      });
                      const tone = item.severity === "bad" ? "bad" : "warn";
                      return (
                        <div
                          key={`${item.dealId}-${item.issueKey}`}
                          className="glance-item glance-in"
                          data-tone={tone}
                          style={{ animationDelay: `${index * 30}ms` }}
                          data-testid={`row-focus-${item.dealId}-${item.issueKey}`}
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium">{item.dealName}</p>
                              <StatusPill tone={tone} label={item.issue} />
                            </div>
                            <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                              {item.stage} · {item.detail}
                            </p>
                          </div>
                          <Button asChild size="sm" variant={tone === "bad" ? "destructive" : "default"}>
                            <Link href={step.href} data-testid={`link-focus-action-${item.dealId}`}>
                              {item.issueKey === "no_plates" ? (
                                <FileUp className="mr-1.5 h-3.5 w-3.5" />
                              ) : (
                                <ListOrdered className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {step.label}
                            </Link>
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </WorkspaceSection>
            ) : (
              <WorkspaceSection
                eyebrow="Shortcut"
                title={`${intakeCount} waiting`}
                description={meta.description}
                actions={
                  <StatusPill
                    tone={intakeCount > 0 ? "warn" : "good"}
                    label={intakeCount > 0 ? "Open" : "Clear"}
                  />
                }
                testId="panel-focus-intake"
              >
                <p className="text-sm text-muted-foreground">
                  {intakeCount > 0
                    ? "Jump into Intake to review forms or nudge buyers who haven’t finished yet."
                    : "No intake items in this bucket."}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild size="sm" data-testid="button-focus-open-intake">
                    <Link href="/orders">
                      <Link2 className="mr-1.5 h-3.5 w-3.5" />
                      {meta.workspaceLabel}
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <a href="https://app.hubspot.com/" target="_blank" rel="noopener noreferrer">
                      HubSpot
                      <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
              </WorkspaceSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}
