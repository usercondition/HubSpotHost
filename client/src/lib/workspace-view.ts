/**
 * Optional workspace view. Independent of Dark/Light (and of Chillsynth if that lands).
 * Default stays the existing ops pages. Workshop is opt-in via Setup or the nav link.
 */

export const WORKSPACE_VIEW_KEY = "print-ops-workspace-view";

export const WORKSPACE_VIEWS = ["ops", "workshop"] as const;

export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];

export const WORKSPACE_VIEW_OPTIONS: Array<{
  id: WorkspaceView;
  label: string;
  hint: string;
}> = [
  { id: "ops", label: "Standard", hint: "Work hub, Stack, and Print queue — unchanged" },
  { id: "workshop", label: "Workshop", hint: "Optional 3D shop floor. Read-only. Does not write to HubSpot" },
];

export function parseWorkspaceView(value: string | null | undefined): WorkspaceView {
  if (value === "workshop" || value === "ops") return value;
  return "ops";
}

export function readWorkspaceView(): WorkspaceView {
  if (typeof window === "undefined") return "ops";
  try {
    return parseWorkspaceView(window.localStorage.getItem(WORKSPACE_VIEW_KEY));
  } catch {
    return "ops";
  }
}

export function writeWorkspaceView(view: WorkspaceView) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKSPACE_VIEW_KEY, view);
  } catch {
    // Private mode — in-memory selection still works for this session.
  }
}
