import type { HealthResponse, HubspotSyncSummary } from "@shared/schema";

export type WorkshopTagTone = "green" | "amber" | "off";

export type WorkshopDriveStatus = {
  configured?: boolean;
  connected?: boolean;
  reconnect?: boolean;
};

export type WorkshopIntegrationTag = {
  id: "hubspot" | "railway" | "drive" | "files";
  label: string;
  tone: WorkshopTagTone;
  detail: string;
};

function hubspotTone(summary: HubspotSyncSummary | null | undefined): WorkshopIntegrationTag {
  if (!summary) {
    return { id: "hubspot", label: "HubSpot", tone: "off", detail: "No sync yet" };
  }
  if (summary.status === "ok" && (summary.issueCount ?? 0) === 0 && (summary.writes?.failed ?? 0) === 0) {
    return { id: "hubspot", label: "HubSpot", tone: "green", detail: "In sync" };
  }
  if (summary.status === "error") {
    return { id: "hubspot", label: "HubSpot", tone: "amber", detail: "Needs a look" };
  }
  const issues = summary.issueCount ?? 0;
  return {
    id: "hubspot",
    label: "HubSpot",
    tone: "amber",
    detail: issues > 0 ? `${issues} ${issues === 1 ? "issue" : "issues"}` : "Check sync",
  };
}

function railwayTone(storage: HealthResponse["storage"] | null | undefined): WorkshopIntegrationTag {
  if (storage?.durableVolumeLikely && storage.configured && !storage.ephemeral) {
    return { id: "railway", label: "Railway", tone: "green", detail: "Durable storage" };
  }
  if (storage?.ephemeral || storage?.warning) {
    return { id: "railway", label: "Railway", tone: "amber", detail: "Storage is ephemeral" };
  }
  if (storage?.configured) {
    return { id: "railway", label: "Railway", tone: "green", detail: "Connected" };
  }
  return { id: "railway", label: "Railway", tone: "off", detail: "Not confirmed" };
}

function driveTone(drive: WorkshopDriveStatus | null | undefined): WorkshopIntegrationTag {
  if (drive?.connected && !drive.reconnect) {
    return { id: "drive", label: "Google Drive", tone: "green", detail: "Connected" };
  }
  if (drive?.reconnect) {
    return { id: "drive", label: "Google Drive", tone: "amber", detail: "Needs reconnect" };
  }
  if (drive?.configured) {
    return { id: "drive", label: "Google Drive", tone: "amber", detail: "Not connected" };
  }
  return { id: "drive", label: "Google Drive", tone: "off", detail: "Not set up" };
}

function filesTone(input: {
  drive?: WorkshopDriveStatus | null;
  libraryCount?: number | null;
}): WorkshopIntegrationTag {
  const count = input.libraryCount ?? 0;
  if (count > 0) {
    return { id: "files", label: "File library", tone: "green", detail: `${count} in library` };
  }
  if (input.drive?.connected && !input.drive.reconnect) {
    return { id: "files", label: "File library", tone: "green", detail: "Drive ready" };
  }
  if (input.drive?.configured) {
    return { id: "files", label: "File library", tone: "amber", detail: "No plates yet" };
  }
  return { id: "files", label: "File library", tone: "off", detail: "No files yet" };
}

export function workshopIntegrationTags(input: {
  hubspotSync?: HubspotSyncSummary | null;
  storage?: HealthResponse["storage"] | null;
  drive?: WorkshopDriveStatus | null;
  libraryCount?: number | null;
}): WorkshopIntegrationTag[] {
  return [
    hubspotTone(input.hubspotSync),
    railwayTone(input.storage),
    driveTone(input.drive),
    filesTone({ drive: input.drive, libraryCount: input.libraryCount }),
  ];
}
