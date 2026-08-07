/**
 * Reprint / failure log for shop-floor waste and QC rejects.
 */
import { desc, eq } from "drizzle-orm";
import {
  productionFailures,
  type CreateProductionFailureInput,
  type ProductionFailure,
  type ProductionFailureType,
} from "../../shared/schema";
import { getDb } from "./order-links";

function nowIso(): string {
  return new Date().toISOString();
}

export function createProductionFailure(input: CreateProductionFailureInput): ProductionFailure {
  const createdAt = nowIso();
  const occurredAt = input.occurredAt?.trim() || createdAt;
  return getDb()
    .insert(productionFailures)
    .values({
      hubspotDealId: input.dealId.trim(),
      hubspotDealName: (input.dealName || "").trim().slice(0, 250),
      failureType: input.failureType,
      printerId: input.printerId ?? null,
      printFileRecordId: input.printFileRecordId ?? null,
      resinMassG: (input.resinMassG || "").trim(),
      notes: (input.notes || "").trim(),
      occurredAt,
      createdAt,
    })
    .returning()
    .get();
}

export function listProductionFailures(limit = 40): ProductionFailure[] {
  return getDb()
    .select()
    .from(productionFailures)
    .orderBy(desc(productionFailures.occurredAt), desc(productionFailures.id))
    .limit(Math.max(1, Math.min(limit, 200)))
    .all();
}

export function listFailuresForDeal(dealId: string, limit = 30): ProductionFailure[] {
  return getDb()
    .select()
    .from(productionFailures)
    .where(eq(productionFailures.hubspotDealId, dealId.trim()))
    .orderBy(desc(productionFailures.occurredAt), desc(productionFailures.id))
    .limit(Math.max(1, Math.min(limit, 100)))
    .all();
}

export function failureSummary(row: ProductionFailure): {
  id: number;
  dealId: string;
  dealName: string;
  failureType: ProductionFailureType;
  notes: string;
  occurredAt: string;
  printerId: number | null;
} {
  return {
    id: row.id,
    dealId: row.hubspotDealId,
    dealName: row.hubspotDealName || row.hubspotDealId,
    failureType: row.failureType as ProductionFailureType,
    notes: row.notes,
    occurredAt: row.occurredAt,
    printerId: row.printerId,
  };
}
