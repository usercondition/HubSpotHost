/**
 * Legacy Floor focus shortcuts (`/#/focus/plates`).
 * Pressure chips now jump straight to the workspace; this route redirects.
 */
import { useEffect } from "react";
import { useLocation, useRoute } from "wouter";
import {
  floorFocusMeta,
  isFloorFocusKind,
  readHashQueryParam,
  type FloorFocusKind,
} from "@/lib/workflow";
import { PageHeader } from "@/components/shell";

function useFocusKind(): FloorFocusKind {
  const [, params] = useRoute("/focus/:kind");
  if (isFloorFocusKind(params?.kind)) return params.kind;
  const fromQuery = readHashQueryParam("kind");
  if (isFloorFocusKind(fromQuery)) return fromQuery;
  return "plates";
}

export default function FloorFocusPage() {
  const kind = useFocusKind();
  const meta = floorFocusMeta(kind);
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation(meta.workspaceHref);
  }, [meta.workspaceHref, setLocation]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={meta.title} subtitle={`Opening ${meta.workspaceLabel}…`} />
      <p className="text-sm text-muted-foreground" data-testid="text-focus-redirect">
        Focus lists moved into Floor and the real workspaces (Prints, Queue, Intake).
      </p>
    </div>
  );
}
