import type { Express, Request, Response } from "express";

/**
 * Temporary Sentry verification hook. Off unless SENTRY_TEST_ROUTE=1, and even
 * then it requires the owner access code. Throws a fixed error with no request
 * data so the real Sentry init + Express error capture path can be confirmed.
 */
export function registerSentryTestRoute(
  app: Express,
  rejectUnsecured: (req: Request, res: Response) => boolean,
) {
  app.post("/api/owner/sentry-test", (req: Request, res: Response) => {
    if (process.env.SENTRY_TEST_ROUTE !== "1") {
      return res.status(404).json({ ok: false, error: "Not found" });
    }
    if (rejectUnsecured(req, res)) return;
    throw new Error("Print Ops Sentry verification error (owner test route)");
  });
}
