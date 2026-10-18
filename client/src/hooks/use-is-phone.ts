import { useSyncExternalStore } from "react";
import { PHONE_QUERIES, isPhoneFrom } from "@/lib/phone";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const lists = PHONE_QUERIES.map((query) => window.matchMedia(query));
  lists.forEach((list) => list.addEventListener("change", onChange));
  return () => lists.forEach((list) => list.removeEventListener("change", onChange));
}

function snapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return isPhoneFrom((query) => window.matchMedia(query).matches);
}

/**
 * True on phones: viewport under 768px, or a coarse-pointer phone held sideways.
 * Desktop (fine pointer, wide) is always false, so desktop rendering is unchanged.
 */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
