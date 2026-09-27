/** Lets a database reset drop mesh work that belonged to the previous store. */
let epoch = 0;
let clearPending = () => {};

export function registerPlateMeshGate(clear: () => void): void {
  clearPending = clear;
}

export function plateMeshEpoch(): number {
  return epoch;
}

export function cancelPlateMeshes(): void {
  epoch += 1;
  clearPending();
}
