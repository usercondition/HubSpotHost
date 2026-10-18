/**
 * Route-level code splitting: each page is its own chunk, loaded on first visit.
 *
 * After a deploy, an open tab still references the previous build's hashed chunk names, which no longer
 * exist. When a chunk fails to load we reload the page once (guarded per tab) so the new index.html and
 * chunks are picked up instead of leaving a blank page.
 */
import { lazy, type ComponentType } from "react";

const RELOAD_KEY = "print-ops-chunk-reload-at";

function reloadOnceForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage blocked: still try a single reload.
  }
  window.location.reload();
  return true;
}

if (typeof window !== "undefined") {
  // Vite fires this when a modulepreload / dynamic import of a stale chunk fails.
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnceForStaleChunk()) event.preventDefault();
  });
}

export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((error: unknown) => {
      if (reloadOnceForStaleChunk()) return new Promise<{ default: T }>(() => {});
      throw error;
    }),
  );
}

export function PageFallback() {
  return (
    <div className="p-6 text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="page-loading">
      Loading…
    </div>
  );
}
