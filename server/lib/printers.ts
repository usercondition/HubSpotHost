/**
 * Printer fleet registry and usage rollups from attached plate metrics.
 *
 * Each CTB/ULTX plate carries a slicer machine name (`printerProfile`). Those
 * strings are matched to fleet printers by name + aliases so hours, layers,
 * resin, jobs, and FEP/screen life can be broken down per machine.
 */
import { and, asc, desc, eq, gte } from "drizzle-orm";
import {
  printerLifecycleEvents,
  printerProfileMaps,
  printers,
  printFileRecords,
  type AssignPrinterProfileInput,
  type CreatePrinterLifecycleEventInput,
  type Printer,
  type PrinterFleetSnapshot,
  type PrinterJobSummary,
  type PrinterLifecycleEvent,
  type PrinterLifecycleEventType,
  type PrinterProfileMap,
  type PrinterStatus,
  type PrinterUsageBreakdown,
  type PrintFileRecord,
  type UpdatePrinterInput,
} from "../../shared/schema";
import { getDb } from "./order-links";

export type SeedPrinter = {
  name: string;
  brand: string;
  model: string;
  aliases: string[];
  sortOrder: number;
  recommendedFepHours: number;
  recommendedFepLayers: number;
};

/** Owner's current fleet, including the HeyGears Reflex Turbo. */
export const DEFAULT_FLEET_PRINTERS: SeedPrinter[] = [
  {
    name: "Mighty 8K NEWX1",
    brand: "ELEGOO",
    model: "Mighty 8K",
    aliases: ["NEWX1", "Mighty 8K NEWX1", "ELEGOO Mighty 8K NEWX1"],
    sortOrder: 10,
    recommendedFepHours: 80,
    recommendedFepLayers: 25_000,
  },
  {
    name: "Mighty 8K NEWX2",
    brand: "ELEGOO",
    model: "Mighty 8K",
    aliases: ["NEWX2", "Mighty 8K NEWX2", "ELEGOO Mighty 8K NEWX2"],
    sortOrder: 20,
    recommendedFepHours: 80,
    recommendedFepLayers: 25_000,
  },
  {
    name: "Mighty 8K NEWX3",
    brand: "ELEGOO",
    model: "Mighty 8K",
    aliases: ["NEWX3", "Mighty 8K NEWX3", "ELEGOO Mighty 8K NEWX3"],
    sortOrder: 30,
    recommendedFepHours: 80,
    recommendedFepLayers: 25_000,
  },
  {
    name: "Mighty 12K NEW",
    brand: "ELEGOO",
    model: "Mighty 12K",
    aliases: ["Mighty 12K NEW", "ELEGOO Mighty 12K NEW", "12K NEW"],
    sortOrder: 40,
    recommendedFepHours: 80,
    recommendedFepLayers: 25_000,
  },
  {
    name: "Mighty 12K OLD",
    brand: "ELEGOO",
    model: "Mighty 12K",
    aliases: ["Mighty 12K OLD", "ELEGOO Mighty 12K OLD", "12K OLD"],
    sortOrder: 50,
    recommendedFepHours: 80,
    recommendedFepLayers: 25_000,
  },
  {
    name: "MEGA 8K",
    brand: "ELEGOO",
    model: "Mega 8K",
    aliases: [
      "MEGA 8K",
      "Mega 8K",
      "ELEGOO MEGA 8K",
      "ELEGOO Mega 8K",
      // Chitubox often labels this machine with the Phrozen profile name.
      "Phrozen Sonic Mega 8K S",
      "Phrozen Sonic Mega 8K",
      "Phrozen Mega 8K",
      "Phrozen Mega",
      "Sonic Mega 8K S",
      "Sonic Mega 8K",
      "PhrozenSonicMega8KS",
      "PhrozenSonicMega8K",
    ],
    sortOrder: 60,
    recommendedFepHours: 80,
    recommendedFepLayers: 25_000,
  },
  {
    name: "Phrozen Mega",
    brand: "Phrozen",
    model: "Mega 8K",
    aliases: ["Phrozen Mega (dedicated)", "Phrozen Mega fleet spare"],
    sortOrder: 65,
    recommendedFepHours: 80,
    recommendedFepLayers: 25_000,
  },
  {
    name: "Mighty 8K OLD",
    brand: "ELEGOO",
    model: "Mighty 8K",
    aliases: ["Mighty 8K OLD", "ELEGOO Mighty 8K OLD", "8K OLD"],
    sortOrder: 70,
    recommendedFepHours: 80,
    recommendedFepLayers: 25_000,
  },
  {
    name: "HeyGears Reflex Turbo",
    brand: "HeyGears",
    model: "UltraCraft Reflex RS Turbo",
    aliases: [
      "HeyGears Reflex Turbo",
      "Heygears Reflex Turbo",
      "Reflex Turbo",
      "Reflex RS Turbo",
      "UltraCraft Reflex RS Turbo",
      "UltraCraft Reflex Turbo",
      "HeyGears",
    ],
    sortOrder: 80,
    recommendedFepHours: 100,
    recommendedFepLayers: 30_000,
  },
];

function nowIso(): string {
  return new Date().toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function asNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePrinterKey(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function parseAliases(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0)
      .slice(0, 40);
  } catch {
    return [];
  }
}

function mergeAliasLists(existing: string[], seed: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const alias of [...existing, ...seed]) {
    const trimmed = alias.trim();
    if (!trimmed) continue;
    const key = normalizePrinterKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
    if (merged.length >= 40) break;
  }
  return merged;
}

export function ensureDefaultPrinters(): Printer[] {
  const db = getDb();
  const existing = db.select().from(printers).all();
  const byName = new Map(existing.map((row) => [normalizePrinterKey(row.name), row]));
  const now = nowIso();

  for (const seed of DEFAULT_FLEET_PRINTERS) {
    const key = normalizePrinterKey(seed.name);
    const current = byName.get(key);
    if (!current) {
      db.insert(printers)
        .values({
          name: seed.name,
          brand: seed.brand,
          model: seed.model,
          status: "active",
          aliasesJson: JSON.stringify(seed.aliases),
          notes: "",
          recommendedFepHours: String(seed.recommendedFepHours),
          recommendedFepLayers: String(seed.recommendedFepLayers),
          sortOrder: seed.sortOrder,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      continue;
    }

    // Keep Railway fleets up to date when we learn new Chitubox machine labels.
    const merged = mergeAliasLists(parseAliases(current.aliasesJson), seed.aliases);
    if (JSON.stringify(merged) !== JSON.stringify(parseAliases(current.aliasesJson))) {
      db.update(printers)
        .set({ aliasesJson: JSON.stringify(merged), updatedAt: now })
        .where(eq(printers.id, current.id))
        .run();
    }
  }

  return db.select().from(printers).orderBy(asc(printers.sortOrder), asc(printers.name)).all();
}

export function listPrinterProfileMaps(): PrinterProfileMap[] {
  return getDb().select().from(printerProfileMaps).all();
}

export function assignPrinterProfile(input: AssignPrinterProfileInput): {
  map: PrinterProfileMap;
  fleet: PrinterFleetSnapshot;
} | null {
  const fleetRows = ensureDefaultPrinters();
  const printer = fleetRows.find((row) => row.id === input.printerId);
  if (!printer) return null;

  const profileLabel = input.profile.trim() || "(blank machine name)";
  const profileKey = normalizePrinterKey(profileLabel) || "(blank)";
  const now = nowIso();
  const existing = getDb()
    .select()
    .from(printerProfileMaps)
    .where(eq(printerProfileMaps.profileKey, profileKey))
    .get();

  let map: PrinterProfileMap;
  if (existing) {
    map = getDb()
      .update(printerProfileMaps)
      .set({
        profileLabel,
        printerId: input.printerId,
        updatedAt: now,
      })
      .where(eq(printerProfileMaps.id, existing.id))
      .returning()
      .get();
  } else {
    map = getDb()
      .insert(printerProfileMaps)
      .values({
        profileKey,
        profileLabel,
        printerId: input.printerId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  // Also keep the chosen machine's alias list aware of this label for visibility.
  const merged = mergeAliasLists(parseAliases(printer.aliasesJson), [profileLabel]);
  getDb()
    .update(printers)
    .set({ aliasesJson: JSON.stringify(merged), updatedAt: now })
    .where(eq(printers.id, printer.id))
    .run();

  return { map, fleet: buildPrinterFleetSnapshot() };
}

export function matchTokens(profile: string, candidate: string): boolean {
  const profileKey = normalizePrinterKey(profile);
  const candidateKey = normalizePrinterKey(candidate);
  if (!profileKey || !candidateKey) return false;
  if (profileKey === candidateKey) return true;

  const candidateTokens = candidateKey.split(" ").filter(Boolean);
  // Single short tokens like NEWX1 must match as whole words so they do not
  // accidentally hit every Mighty 8K plate. Multi-word aliases (e.g. "mega 8k",
  // "phrozen mega") use substring matching.
  if (candidateTokens.length === 1) {
    const token = candidateTokens[0]!;
    if (/^[a-z]*\d+[a-z0-9]*$/.test(token) || token.length <= 8) {
      return profileKey.split(" ").includes(token);
    }
  }

  return profileKey.includes(candidateKey) || candidateKey.includes(profileKey);
}

/** Resolve a slicer machine string to a fleet printer id, or null if unmatched. */
export function matchPrinterId(
  printerProfile: string | null | undefined,
  fleet: Printer[],
  profileMaps: PrinterProfileMap[] = listPrinterProfileMaps(),
): number | null {
  const profile = String(printerProfile ?? "").trim() || "(blank machine name)";
  const profileKey = normalizePrinterKey(profile) || "(blank)";

  // Manual assignments always win — used for odd Chitubox labels like Phrozen Sonic Mega 8K S.
  const mapped = profileMaps.find((row) => row.profileKey === profileKey);
  if (mapped && fleet.some((printer) => printer.id === mapped.printerId)) {
    return mapped.printerId;
  }

  // Prefer longer / more specific aliases so NEWX1 beats generic Mighty 8K.
  const ranked = fleet
    .flatMap((printer) => {
      const aliases = [printer.name, ...parseAliases(printer.aliasesJson)];
      return aliases.map((alias) => ({
        printerId: printer.id,
        alias,
        score: normalizePrinterKey(alias).length,
      }));
    })
    .sort((a, b) => b.score - a.score);

  for (const entry of ranked) {
    if (matchTokens(profile, entry.alias)) return entry.printerId;
  }
  return null;
}

function toJobSummary(record: PrintFileRecord): PrinterJobSummary {
  return {
    recordId: record.id,
    dealId: record.hubspotDealId,
    dealName: record.hubspotDealName,
    fileName: record.fileName,
    formatRevision: record.formatRevision,
    printerProfile: record.printerProfile,
    printTimeSeconds: record.printTimeSeconds,
    layerCount: record.layerCount,
    resinVolumeMl: asNumber(record.resinVolumeMl),
    resinMassG: asNumber(record.resinMassG),
    attachedAt: record.attachedAt,
  };
}

function usageSince(
  jobs: PrintFileRecord[],
  sinceIso: string | null,
): { hours: number; layers: number } {
  const filtered = sinceIso
    ? jobs.filter((job) => job.attachedAt >= sinceIso)
    : jobs;
  let seconds = 0;
  let layers = 0;
  for (const job of filtered) {
    if (job.printTimeSeconds && job.printTimeSeconds > 0) seconds += job.printTimeSeconds;
    if (job.layerCount && job.layerCount > 0) layers += job.layerCount;
  }
  return { hours: round2(seconds / 3_600), layers };
}

function latestEventAt(
  events: PrinterLifecycleEvent[],
  type: PrinterLifecycleEventType,
): string | null {
  const match = events.find((event) => event.eventType === type);
  return match?.occurredAt ?? null;
}

function buildPrinterBreakdown(
  printer: Printer,
  jobs: PrintFileRecord[],
  events: PrinterLifecycleEvent[],
): PrinterUsageBreakdown {
  let totalPrintTimeSeconds = 0;
  let totalLayers = 0;
  let totalResinVolumeMl = 0;
  let totalResinMassG = 0;
  const dealIds = new Set<string>();
  const profiles = new Set<string>();
  let firstJobAt: string | null = null;
  let lastJobAt: string | null = null;

  for (const job of jobs) {
    if (job.printTimeSeconds && job.printTimeSeconds > 0) totalPrintTimeSeconds += job.printTimeSeconds;
    if (job.layerCount && job.layerCount > 0) totalLayers += job.layerCount;
    const volume = asNumber(job.resinVolumeMl);
    const mass = asNumber(job.resinMassG);
    if (volume != null) totalResinVolumeMl += volume;
    if (mass != null) totalResinMassG += mass;
    dealIds.add(job.hubspotDealId);
    if (job.printerProfile?.trim()) profiles.add(job.printerProfile.trim());
    if (!firstJobAt || job.attachedAt < firstJobAt) firstJobAt = job.attachedAt;
    if (!lastJobAt || job.attachedAt > lastJobAt) lastJobAt = job.attachedAt;
  }

  const fepInstalledAt = latestEventAt(events, "fep_replaced");
  const screenInstalledAt = latestEventAt(events, "screen_replaced");
  const sinceFep = usageSince(jobs, fepInstalledAt);
  const sinceScreen = usageSince(jobs, screenInstalledAt);
  const recommendedFepHours = asNumber(printer.recommendedFepHours) ?? 80;
  const recommendedFepLayers = asNumber(printer.recommendedFepLayers) ?? 25_000;

  return {
    printerId: printer.id,
    name: printer.name,
    brand: printer.brand,
    model: printer.model,
    status: (printer.status === "retired" ? "retired" : "active") as PrinterStatus,
    aliases: parseAliases(printer.aliasesJson),
    notes: printer.notes,
    recommendedFepHours,
    recommendedFepLayers,
    plateCount: jobs.length,
    totalPrintTimeSeconds,
    totalPrintHours: round2(totalPrintTimeSeconds / 3_600),
    totalLayers,
    totalResinVolumeMl: round2(totalResinVolumeMl),
    totalResinMassG: round2(totalResinMassG),
    distinctOrders: dealIds.size,
    firstJobAt,
    lastJobAt,
    matchedProfiles: Array.from(profiles).sort((a, b) => a.localeCompare(b)),
    fepInstalledAt,
    hoursSinceFep: sinceFep.hours,
    layersSinceFep: sinceFep.layers,
    fepHoursUsedPercent:
      recommendedFepHours > 0 ? round2((sinceFep.hours / recommendedFepHours) * 100) : null,
    fepLayersUsedPercent:
      recommendedFepLayers > 0 ? round2((sinceFep.layers / recommendedFepLayers) * 100) : null,
    screenInstalledAt,
    hoursSinceScreen: sinceScreen.hours,
    layersSinceScreen: sinceScreen.layers,
    recentJobs: jobs.slice(0, 12).map(toJobSummary),
    lifecycleEvents: events.slice(0, 20),
  };
}

export function buildPrinterFleetSnapshot(): PrinterFleetSnapshot {
  const fleet = ensureDefaultPrinters();
  const records = getDb()
    .select()
    .from(printFileRecords)
    .orderBy(desc(printFileRecords.attachedAt), desc(printFileRecords.id))
    .limit(2_000)
    .all();
  const allEvents = getDb()
    .select()
    .from(printerLifecycleEvents)
    .orderBy(desc(printerLifecycleEvents.occurredAt), desc(printerLifecycleEvents.id))
    .all();

  const eventsByPrinter = new Map<number, PrinterLifecycleEvent[]>();
  for (const event of allEvents) {
    const list = eventsByPrinter.get(event.printerId) ?? [];
    list.push(event);
    eventsByPrinter.set(event.printerId, list);
  }

  const profileMaps = listPrinterProfileMaps();
  const jobsByPrinter = new Map<number, PrintFileRecord[]>();
  const unassigned: PrintFileRecord[] = [];
  const fleetIds = new Set(fleet.map((printer) => printer.id));
  for (const record of records) {
    const printerId =
      record.assignedPrinterId != null && fleetIds.has(record.assignedPrinterId)
        ? record.assignedPrinterId
        : matchPrinterId(record.printerProfile, fleet, profileMaps);
    if (printerId == null) {
      unassigned.push(record);
      continue;
    }
    const list = jobsByPrinter.get(printerId) ?? [];
    list.push(record);
    jobsByPrinter.set(printerId, list);
  }

  const printerBreakdowns = fleet.map((printer) =>
    buildPrinterBreakdown(
      printer,
      jobsByPrinter.get(printer.id) ?? [],
      eventsByPrinter.get(printer.id) ?? [],
    ),
  );

  const unassignedProfiles = new Map<string, { plateCount: number; seconds: number }>();
  let unassignedSeconds = 0;
  let unassignedLayers = 0;
  for (const job of unassigned) {
    if (job.printTimeSeconds && job.printTimeSeconds > 0) unassignedSeconds += job.printTimeSeconds;
    if (job.layerCount && job.layerCount > 0) unassignedLayers += job.layerCount;
    const key = job.printerProfile?.trim() || "(blank machine name)";
    const entry = unassignedProfiles.get(key) ?? { plateCount: 0, seconds: 0 };
    entry.plateCount += 1;
    entry.seconds += job.printTimeSeconds && job.printTimeSeconds > 0 ? job.printTimeSeconds : 0;
    unassignedProfiles.set(key, entry);
  }

  const fleetPlateCount = printerBreakdowns.reduce((sum, item) => sum + item.plateCount, 0);
  const fleetHours = printerBreakdowns.reduce((sum, item) => sum + item.totalPrintHours, 0);
  const fleetLayers = printerBreakdowns.reduce((sum, item) => sum + item.totalLayers, 0);

  return {
    printers: printerBreakdowns,
    unassigned: {
      plateCount: unassigned.length,
      totalPrintTimeSeconds: unassignedSeconds,
      totalPrintHours: round2(unassignedSeconds / 3_600),
      totalLayers: unassignedLayers,
      profiles: Array.from(unassignedProfiles.entries())
        .map(([profile, stats]) => ({
          profile,
          plateCount: stats.plateCount,
          totalPrintHours: round2(stats.seconds / 3_600),
        }))
        .sort((a, b) => b.plateCount - a.plateCount || a.profile.localeCompare(b.profile)),
      recentJobs: unassigned.slice(0, 12).map(toJobSummary),
    },
    fleetTotals: {
      plateCount: fleetPlateCount + unassigned.length,
      totalPrintHours: round2(fleetHours + unassignedSeconds / 3_600),
      totalLayers: fleetLayers + unassignedLayers,
      activePrinters: printerBreakdowns.filter((item) => item.status === "active").length,
    },
  };
}

export function getPrinter(printerId: number): Printer | null {
  ensureDefaultPrinters();
  return getDb().select().from(printers).where(eq(printers.id, printerId)).get() ?? null;
}

export function updatePrinter(printerId: number, input: UpdatePrinterInput): Printer | null {
  const existing = getPrinter(printerId);
  if (!existing) return null;

  const updates: Partial<Printer> = { updatedAt: nowIso() };
  if (input.notes !== undefined) updates.notes = input.notes;
  if (input.status !== undefined) updates.status = input.status;
  if (input.aliases !== undefined) {
    updates.aliasesJson = JSON.stringify(
      input.aliases.map((alias) => alias.trim()).filter(Boolean).slice(0, 40),
    );
  }
  if (input.recommendedFepHours !== undefined) {
    updates.recommendedFepHours = String(input.recommendedFepHours);
  }
  if (input.recommendedFepLayers !== undefined) {
    updates.recommendedFepLayers = String(input.recommendedFepLayers);
  }

  getDb().update(printers).set(updates).where(eq(printers.id, printerId)).run();
  return getPrinter(printerId);
}

export function addPrinterLifecycleEvent(
  printerId: number,
  input: CreatePrinterLifecycleEventInput,
): PrinterLifecycleEvent | null {
  const existing = getPrinter(printerId);
  if (!existing) return null;

  const createdAt = nowIso();
  const occurredAt = new Date(input.occurredAt).toISOString();
  const row = getDb()
    .insert(printerLifecycleEvents)
    .values({
      printerId,
      eventType: input.eventType,
      occurredAt,
      notes: input.notes ?? "",
      createdAt,
    })
    .returning()
    .get();

  if (input.eventType === "retired" || input.eventType === "reactivated") {
    getDb()
      .update(printers)
      .set({
        status: input.eventType === "retired" ? "retired" : "active",
        updatedAt: createdAt,
      })
      .where(eq(printers.id, printerId))
      .run();
  }

  return row;
}

export function listPrinterLifecycleEvents(printerId: number, limit = 50): PrinterLifecycleEvent[] {
  return getDb()
    .select()
    .from(printerLifecycleEvents)
    .where(eq(printerLifecycleEvents.printerId, printerId))
    .orderBy(desc(printerLifecycleEvents.occurredAt), desc(printerLifecycleEvents.id))
    .limit(Math.max(1, Math.min(limit, 200)))
    .all();
}

/** Test helper: count plates assigned to a printer after a given attachedAt. */
export function countJobsForPrinterSince(printerId: number, sinceIso: string): number {
  const fleet = ensureDefaultPrinters();
  const printer = fleet.find((row) => row.id === printerId);
  if (!printer) return 0;
  const records = getDb()
    .select()
    .from(printFileRecords)
    .where(and(gte(printFileRecords.attachedAt, sinceIso)))
    .all();
  return records.filter((record) => matchPrinterId(record.printerProfile, fleet) === printerId).length;
}
