/**
 * Hash location for wouter that keeps `?query` inside the hash.
 *
 * Stock `wouter/use-hash-location` navigate() splits `to` on `?` and moves the
 * query onto `location.search`, leaving `#/focus` without `?kind=…`. Kind chips
 * and `?dealId=` deep links then look dead (hash never changes / param missing).
 */
import { useSyncExternalStore } from "react";
import { searchWithoutParam } from "@/lib/workflow";

type NavigateOpts = { replace?: boolean; state?: unknown };

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  if (listeners.size === 1) {
    window.addEventListener("hashchange", notify);
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) {
      window.removeEventListener("hashchange", notify);
    }
  };
}

/**
 * Route path from the hash only (`#/focus?kind=plates` → `/focus`).
 *
 * Wouter matches this value against route paths, so hash query strings must be
 * excluded. They remain in `window.location.hash` for readHashQueryParam().
 */
export function currentHashPath(): string {
  const raw = window.location.hash.replace(/^#/, "");
  const hashPath = raw.split("?", 1)[0];
  if (!hashPath || hashPath === "/") return "/";
  return hashPath.startsWith("/") ? hashPath : `/${hashPath}`;
}

export function navigateHash(to: string, opts: NavigateOpts = {}) {
  const path = to.startsWith("/") ? to : `/${to}`;
  const nextHash = `#${path}`;
  // Tab hrefs are bare paths. A stale `/?dealId=` before the hash must not survive the click.
  const search = searchWithoutParam(window.location.search, "dealId");
  const searchChanged = search !== window.location.search;

  if (opts.replace || searchChanged) {
    window.history.replaceState(
      opts.state ?? null,
      "",
      `${window.location.pathname}${search}${nextHash}`,
    );
    // replaceState may not emit hashchange; keep subscribers in sync.
    notify();
    return;
  }

  if (window.location.hash === nextHash) {
    notify();
    return;
  }

  window.location.hash = nextHash;
}

export function useAppHashLocation(): [string, typeof navigateHash] {
  const location = useSyncExternalStore(subscribe, currentHashPath, () => "/");
  return [location, navigateHash];
}

useAppHashLocation.hrefs = (href: string) => {
  if (href.startsWith("#")) return href;
  return `#${href.startsWith("/") ? href : `/${href}`}`;
};
