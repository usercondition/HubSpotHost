/**
 * Hash location for wouter that keeps `?query` inside the hash.
 *
 * Stock `wouter/use-hash-location` navigate() splits `to` on `?` and moves the
 * query onto `location.search`, leaving `#/focus` without `?kind=…`. Kind chips
 * and `?dealId=` deep links then look dead (hash never changes / param missing).
 */
import { useSyncExternalStore } from "react";

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

/** Path + search from the hash only (`#/focus?kind=plates` → `/focus?kind=plates`). */
export function currentHashPath(): string {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw || raw === "/") return "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function navigateHash(to: string, opts: NavigateOpts = {}) {
  const path = to.startsWith("/") ? to : `/${to}`;
  const nextHash = `#${path}`;

  if (opts.replace) {
    window.history.replaceState(
      opts.state ?? null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash}`,
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
