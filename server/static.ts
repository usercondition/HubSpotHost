import express from 'express';
import type { Express, Response } from 'express';
import fs from "node:fs";
import path from "node:path";

/** Vite content-hashes everything under assets/, so a given URL never changes: cache it for a year. */
export const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** index.html (and other unhashed files) must revalidate so a deploy is picked up on the next load. */
export const HTML_CACHE_CONTROL = "no-cache";

function setNoCache(res: Response) {
  res.setHeader("Cache-Control", HTML_CACHE_CONTROL);
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Hashed JS/CSS/fonts. A missing hashed file is a 404 (not index.html) so a stale tab's failed chunk
  // load is detected client-side and triggers a reload instead of parsing HTML as JavaScript.
  app.use(
    "/assets",
    express.static(path.join(distPath, "assets"), {
      immutable: true,
      maxAge: "1y",
      index: false,
      fallthrough: false,
    }),
  );

  app.use(
    express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) setNoCache(res);
      },
    }),
  );

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    setNoCache(res);
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
