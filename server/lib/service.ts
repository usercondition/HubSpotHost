/**
 * Recalculation service: read inputs, compute, decide, optionally write, audit.
 */
import { calculateProfit, toOutputProperties, type CalcResult } from "./calc";
import { getConfig, resolveWriteDecision } from "./config";
import { fetchDealInputs, patchDealOutputs, HubSpotError } from "./hubspot";
import { recordAttempt, truncateError, type TriggerOrigin } from "./audit";

export interface RecalcOutcome {
  dealId: string;
  status: "written" | "dry-run" | "error";
  dryRun: boolean;
  gate: string;
  grossProfit?: number;
  marginPercentage?: number;
  costTotal?: number;
  error?: string;
}

export async function recalculateDeal(params: {
  dealId: string;
  origin: TriggerOrigin;
  requestWantsLiveWrite: boolean;
}): Promise<RecalcOutcome> {
  const { dealId, origin, requestWantsLiveWrite } = params;
  const config = getConfig();
  const decision = resolveWriteDecision(config, requestWantsLiveWrite);

  let calc: CalcResult | null = null;
  try {
    const properties = await fetchDealInputs(dealId);
    calc = calculateProfit(properties);

    if (decision.write) {
      await patchDealOutputs(dealId, toOutputProperties(calc));
      recordAttempt({
        dealId,
        origin,
        status: "written",
        dryRun: false,
        gate: decision.reason,
        calc,
      });
      return {
        dealId,
        status: "written",
        dryRun: false,
        gate: decision.reason,
        grossProfit: calc.grossProfit,
        marginPercentage: calc.marginPercentage,
        costTotal: calc.costTotal,
      };
    }

    recordAttempt({
      dealId,
      origin,
      status: "dry-run",
      dryRun: true,
      gate: decision.reason,
      calc,
    });
    return {
      dealId,
      status: "dry-run",
      dryRun: true,
      gate: decision.reason,
      grossProfit: calc.grossProfit,
      marginPercentage: calc.marginPercentage,
      costTotal: calc.costTotal,
    };
  } catch (err) {
    const message =
      err instanceof HubSpotError ? err.message : "Recalculation failed";
    recordAttempt({
      dealId,
      origin,
      status: "error",
      dryRun: !decision.write,
      gate: decision.reason,
      calc,
      error: message,
    });
    return {
      dealId,
      status: "error",
      dryRun: !decision.write,
      gate: decision.reason,
      error: truncateError(message),
    };
  }
}
