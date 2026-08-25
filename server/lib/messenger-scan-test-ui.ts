/**
 * Serve the local Messenger scan test UI (mock thread + lazy scroll).
 * Enabled in development, or when MESSENGER_SCAN_TEST_UI=1.
 */
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";

export function messengerScanTestUiEnabled(): boolean {
  if (process.env.MESSENGER_SCAN_TEST_UI === "1") return true;
  if (process.env.MESSENGER_SCAN_TEST_UI === "0") return false;
  return process.env.NODE_ENV !== "production";
}

export function registerMessengerScanTestUi(app: Express): void {
  if (!messengerScanTestUiEnabled()) return;

  const htmlPath = path.resolve(
    process.cwd(),
    "tools/messenger-send-to-print-ops/test/mock-messenger.html",
  );

  app.get("/dev/mock-messenger", (_req: Request, res: Response) => {
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).type("text/plain").send("Mock Messenger test page is missing from the repo.");
    }
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(htmlPath);
  });
}
