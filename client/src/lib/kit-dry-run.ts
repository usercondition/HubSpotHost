/**
 * Shop-floor kit dry-run: multiple client orders, plates with post-print QC,
 * and a reprint pool that accumulates failures until you choose to slice again.
 */

export type KitBitStatus = "todo" | "printing" | "done" | "needs_reprint";
export type KitBitQcResult = "pending" | "good" | "reprint";
export type KitPlateStatus = "pending_qc" | "inspected";
export type KitPlateKind = "planned" | "reprint";

export type KitBit = {
  id: string;
  fileName: string;
  label: string;
  group: string;
  status: KitBitStatus;
  plateId: string | null;
};

export type KitPlateBit = {
  orderId: string;
  bitId: string;
  result: KitBitQcResult;
};

export type KitPlate = {
  id: string;
  name: string;
  ctbFileName: string;
  kind: KitPlateKind;
  attachedAt: string;
  inspectedAt: string | null;
  status: KitPlateStatus;
  bits: KitPlateBit[];
};

export type KitOrder = {
  id: string;
  clientName: string;
  orderName: string;
  bits: KitBit[];
};

export type ShopDryRun = {
  orders: KitOrder[];
  plates: KitPlate[];
};

export type ReprintPoolItem = {
  orderId: string;
  clientName: string;
  orderName: string;
  bitId: string;
  label: string;
  group: string;
  fileName: string;
};

const ACASTUS_FILES = [
  "01 Carapace.stl",
  "02 Launcher Inner.stl",
  "02 Launcher Outer.stl",
  "02 Launcher.stl",
  "03 Helios Missiles.stl",
  "04 Ironstorm Missiles.stl",
  "05 Launcher Piston x2.stl",
  "06 Hatch.stl",
  "07 Exhaust Right.stl",
  "08 Exhaust Left.stl",
  "09 Torso Lower.stl",
  "10 Right Interior Wall.stl",
  "11 Left Interior Wall.stl",
  "12 Torso Rear.stl",
  "13 Command Throne.stl",
  "14 Interior Front.stl",
  "15 Torso Right.stl",
  "16 Torso Left.stl",
  "17 Gorget Plate.stl",
  "18 Head.stl",
  "19 Face Plate.stl",
  "20 Upper Rear Plate.stl",
  "21 Left Upper Rear Plate.stl",
  "22 Right Upper Rear Plate.stl",
  "23 Left Lower Rear Plate.stl",
  "24 Right Lower Rear Plate.stl",
  "25 Rear Plate Mount x2.stl",
  "26 Left Shoulder Gun Mount.stl",
  "27 Right Shoulder Gun Mount.stl",
  "28 Secondary Autocannon x2.stl",
  "29 Secondary Lascannon x2.stl",
  "30 Right Hand Rail.stl",
  "31 Front Handrail.stl",
  "32 Rear Handrail.stl",
  "35 Imperial Eagle Symbol.stl",
  "37 Torso Front.stl",
  "38 Waist.stl",
  "39 Thigh Left.stl",
  "40 Thigh Right.stl",
  "41 Lower Leg x2.stl",
  "42 Foot x2.stl",
  "43 Toe x8.stl",
  "44 Hip x2.stl",
  "45 Left Thigh Plate.stl",
  "46 Right Thigh Plate.stl",
  "47 Lower Leg Plate Front x2.stl",
  "47 Lower Leg Plate Front.stl",
  "48 Outer Leg Plate x2.stl",
  "49 Leg Plate x4.stl",
  "50 Lower Leg Piston A x2.stl",
  "50 Lower Leg Piston B x2.stl",
  "50 Lower Leg Piston C x4.stl",
  "51 Waist Plate.stl",
  "52 Thigh Piston Cylinder x2.stl",
  "53 Thigh Piston Rod x2.stl",
  "54 Hip Piston Cylinder x2.stl",
  "55 Hip Piston Rod x2.stl",
  "56 Right Leg Cable.stl",
  "57 Left Leg Cable.stl",
  "58 Pennant.stl",
  "59 Heat Sink Power Core x2.stl",
  "60 Arm Weapon Main Body x2.stl",
  "61 Arm Mount x2.stl",
  "62 Barrel x4.stl",
  "63 Sight x2.stl",
  "64 Power Module x2.stl",
  "65 Manifold x2.stl",
  "66 Manifold Pipe x12.stl",
  "67 Side Shield x2.stl",
  "68 Left Shoulder Plate Mount.stl",
  "69 Right Shoulder Plate Mount.stl",
  "70 Left Shoulder Plate.stl",
  "71 Right Shoulder Plate.stl",
  "72 Power Cable x2.stl",
  "73 Secondary Cable A.stl",
  "73 Secondary Cable B.stl",
];

const ARMIGER_FILES = [
  "01 Hull.stl",
  "02 Canopy.stl",
  "03 Leg Left.stl",
  "04 Leg Right.stl",
  "05 Arm Left.stl",
  "06 Arm Right.stl",
  "07 Weapon.stl",
  "08 Base Peg.stl",
];

const CASTELLAN_SAMPLE = [
  "01 Carapace.stl",
  "02 Head.stl",
  "03 Torso.stl",
  "04 Waist.stl",
  "05 Leg Left.stl",
  "06 Leg Right.stl",
  "07 Shoulder Left.stl",
  "08 Shoulder Right.stl",
  "09 Gun Mount.stl",
  "10 Base.stl",
];

function bitNumber(fileName: string): number | null {
  const match = /^(\d+)\b/.exec(fileName.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function groupForFileName(fileName: string): string {
  const n = bitNumber(fileName);
  const lower = fileName.toLowerCase();
  if (n != null) {
    if (n <= 8) return "Carapace / launcher";
    if (n <= 17 || n === 37) return "Torso / interior";
    if (n <= 19) return "Head";
    if (n <= 25) return "Rear plates";
    if ((n >= 26 && n <= 29) || (n >= 68 && n <= 71)) return "Shoulders / secondaries";
    if (n <= 35) return "Rails / details";
    if (n >= 38 && n <= 57) return "Waist / legs";
    if (n === 58 || n === 59) return "Pennant / heat";
    if (n >= 60) return "Arm weapons";
  }
  if (/head|face|canopy/.test(lower)) return "Head";
  if (/leg|thigh|foot|toe|hip|waist/.test(lower)) return "Waist / legs";
  if (/arm|barrel|manifold|shield|weapon/.test(lower)) return "Arm weapons";
  if (/shoulder|cannon|lascannon|gun/.test(lower)) return "Shoulders / secondaries";
  if (/torso|interior|gorget|throne|hull/.test(lower)) return "Torso / interior";
  if (/base|peg/.test(lower)) return "Base";
  return "Other";
}

export function labelFromFileName(fileName: string): string {
  return fileName.replace(/\.stl$/i, "").trim();
}

function bitsFromFileList(files: string[], idPrefix: string): KitBit[] {
  const seen = new Set<string>();
  const bits: KitBit[] = [];
  for (const line of files) {
    const fileName = line.trim();
    if (!fileName) continue;
    const base = fileName.split(/[/\\]/).pop() || fileName;
    const key = base.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bits.push({
      id: `${idPrefix}-${bits.length + 1}-${key.replace(/[^a-z0-9]+/g, "-")}`,
      fileName: base,
      label: labelFromFileName(base),
      group: groupForFileName(base),
      status: "todo",
      plateId: null,
    });
  }
  return bits;
}

export function parseKitFileList(
  raw: string,
  options?: { kitName?: string },
): KitBit[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^["']|["']$/g, ""))
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => (/\.stl$/i.test(line) ? line : `${line}.stl`));
  return bitsFromFileList(lines, options?.kitName?.replace(/\W+/g, "-").toLowerCase() || "kit");
}

export function createSampleShop(): ShopDryRun {
  return {
    orders: [
      {
        id: "order-ada-acastus",
        clientName: "Ada Lovelace",
        orderName: "Acastus Knight Porphyrion",
        bits: bitsFromFileList(ACASTUS_FILES, "acastus"),
      },
      {
        id: "order-ada-armiger",
        clientName: "Ada Lovelace",
        orderName: "Armiger Helverin",
        bits: bitsFromFileList(ARMIGER_FILES, "armiger"),
      },
      {
        id: "order-bob-castellan",
        clientName: "Bob Martin",
        orderName: "Knight Castellan (sample)",
        bits: bitsFromFileList(CASTELLAN_SAMPLE, "castellan"),
      },
    ],
    plates: [],
  };
}

export function isSelectableBit(bit: KitBit): boolean {
  return bit.status === "todo" || bit.status === "needs_reprint";
}

export function orderProgress(order: KitOrder): {
  done: number;
  total: number;
  printing: number;
  reprint: number;
  todo: number;
} {
  const total = order.bits.length;
  return {
    total,
    done: order.bits.filter((bit) => bit.status === "done").length,
    printing: order.bits.filter((bit) => bit.status === "printing").length,
    reprint: order.bits.filter((bit) => bit.status === "needs_reprint").length,
    todo: order.bits.filter((bit) => bit.status === "todo").length,
  };
}

export function shopProgress(shop: ShopDryRun) {
  return shop.orders.reduce(
    (acc, order) => {
      const p = orderProgress(order);
      acc.done += p.done;
      acc.total += p.total;
      acc.printing += p.printing;
      acc.reprint += p.reprint;
      acc.todo += p.todo;
      return acc;
    },
    { done: 0, total: 0, printing: 0, reprint: 0, todo: 0 },
  );
}

export function groupSummaries(order: KitOrder): Array<{
  group: string;
  done: number;
  total: number;
  printing: number;
  reprint: number;
}> {
  const map = new Map<string, { done: number; total: number; printing: number; reprint: number }>();
  for (const bit of order.bits) {
    const entry = map.get(bit.group) ?? { done: 0, total: 0, printing: 0, reprint: 0 };
    entry.total += 1;
    if (bit.status === "done") entry.done += 1;
    if (bit.status === "printing") entry.printing += 1;
    if (bit.status === "needs_reprint") entry.reprint += 1;
    map.set(bit.group, entry);
  }
  return Array.from(map.entries())
    .map(([group, stats]) => ({ group, ...stats }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

export function plateQcCounts(plate: KitPlate): { good: number; reprint: number; pending: number; total: number } {
  let good = 0;
  let reprint = 0;
  let pending = 0;
  for (const row of plate.bits) {
    if (row.result === "good") good += 1;
    else if (row.result === "reprint") reprint += 1;
    else pending += 1;
  }
  return { good, reprint, pending, total: plate.bits.length };
}

/** Failures waiting to be sliced again — not a plate until you create one. */
export function reprintPool(
  shop: ShopDryRun,
  filter?: { orderId?: string; clientName?: string },
): ReprintPoolItem[] {
  const items: ReprintPoolItem[] = [];
  for (const order of shop.orders) {
    if (filter?.orderId && order.id !== filter.orderId) continue;
    if (filter?.clientName && order.clientName !== filter.clientName) continue;
    for (const bit of order.bits) {
      if (bit.status !== "needs_reprint") continue;
      items.push({
        orderId: order.id,
        clientName: order.clientName,
        orderName: order.orderName,
        bitId: bit.id,
        label: bit.label,
        group: bit.group,
        fileName: bit.fileName,
      });
    }
  }
  return items.sort(
    (a, b) =>
      a.clientName.localeCompare(b.clientName) ||
      a.orderName.localeCompare(b.orderName) ||
      a.label.localeCompare(b.label),
  );
}

export function poolKey(item: Pick<ReprintPoolItem, "orderId" | "bitId">): string {
  return `${item.orderId}::${item.bitId}`;
}

function updateOrderBit(
  shop: ShopDryRun,
  orderId: string,
  bitId: string,
  patch: Partial<KitBit>,
): ShopDryRun {
  return {
    ...shop,
    orders: shop.orders.map((order) => {
      if (order.id !== orderId) return order;
      return {
        ...order,
        bits: order.bits.map((bit) => (bit.id === bitId ? { ...bit, ...patch } : bit)),
      };
    }),
  };
}

/**
 * Planned plate for one order: select todo/reprint bits + CTB.
 * Bits become printing; QC later.
 */
export function attachOrderPlate(
  shop: ShopDryRun,
  input: {
    orderId: string;
    plateName: string;
    ctbFileName?: string;
    bitIds: string[];
    kind?: KitPlateKind;
  },
  now: Date = new Date(),
): { shop: ShopDryRun; ok: true; plateId: string } | { shop: ShopDryRun; ok: false; error: string } {
  const order = shop.orders.find((item) => item.id === input.orderId);
  if (!order) return { shop, ok: false, error: "Order not found" };

  const bitIds = Array.from(new Set(input.bitIds)).filter((id) =>
    order.bits.some((bit) => bit.id === id && isSelectableBit(bit)),
  );
  if (bitIds.length === 0) return { shop, ok: false, error: "Select at least one queued bit" };

  const plateNumber = shop.plates.length + 1;
  const plateId = `plate-${plateNumber}-${now.getTime()}`;
  const plateName = input.plateName.trim() || `Plate ${plateNumber}`;
  const plate: KitPlate = {
    id: plateId,
    name: plateName,
    ctbFileName: input.ctbFileName?.trim() || `${plateName.replace(/[^\w.-]+/g, "_")}.ctb`,
    kind: input.kind ?? "planned",
    attachedAt: now.toISOString(),
    inspectedAt: null,
    status: "pending_qc",
    bits: bitIds.map((bitId) => ({ orderId: order.id, bitId, result: "pending" })),
  };

  let next: ShopDryRun = { ...shop, plates: [plate, ...shop.plates] };
  for (const bitId of bitIds) {
    next = updateOrderBit(next, order.id, bitId, { status: "printing", plateId });
  }
  return { shop: next, ok: true, plateId };
}

/**
 * Build a reprint plate from pool selections (may span multiple orders).
 * Failures stay pooled until this runs — then they move to printing on the new plate.
 */
export function createPlateFromReprintPool(
  shop: ShopDryRun,
  input: {
    selections: Array<{ orderId: string; bitId: string }>;
    plateName?: string;
    ctbFileName?: string;
  },
  now: Date = new Date(),
): { shop: ShopDryRun; ok: true; plateId: string; count: number } | { shop: ShopDryRun; ok: false; error: string } {
  const unique = new Map<string, { orderId: string; bitId: string }>();
  for (const row of input.selections) {
    unique.set(poolKey(row), row);
  }
  const selections = Array.from(unique.values()).filter(({ orderId, bitId }) => {
    const order = shop.orders.find((item) => item.id === orderId);
    const bit = order?.bits.find((item) => item.id === bitId);
    return bit?.status === "needs_reprint";
  });
  if (selections.length === 0) {
    return { shop, ok: false, error: "Select at least one bit from the reprint pool" };
  }

  const reprintCount = shop.plates.filter((plate) => plate.kind === "reprint").length + 1;
  const plateId = `plate-reprint-${reprintCount}-${now.getTime()}`;
  const plateName = input.plateName?.trim() || `Reprint pool plate ${reprintCount}`;
  const plate: KitPlate = {
    id: plateId,
    name: plateName,
    ctbFileName: input.ctbFileName?.trim() || `Reprint_Pool_P${reprintCount}.ctb`,
    kind: "reprint",
    attachedAt: now.toISOString(),
    inspectedAt: null,
    status: "pending_qc",
    bits: selections.map((row) => ({ ...row, result: "pending" })),
  };

  let next: ShopDryRun = { ...shop, plates: [plate, ...shop.plates] };
  for (const row of selections) {
    next = updateOrderBit(next, row.orderId, row.bitId, { status: "printing", plateId });
  }
  return { shop: next, ok: true, plateId, count: selections.length };
}

export function setPlateBitResult(
  shop: ShopDryRun,
  plateId: string,
  orderId: string,
  bitId: string,
  result: Exclude<KitBitQcResult, "pending">,
): ShopDryRun {
  return {
    ...shop,
    plates: shop.plates.map((plate) => {
      if (plate.id !== plateId || plate.status !== "pending_qc") return plate;
      return {
        ...plate,
        bits: plate.bits.map((row) =>
          row.orderId === orderId && row.bitId === bitId ? { ...row, result } : row,
        ),
      };
    }),
  };
}

export function markAllPlateBits(
  shop: ShopDryRun,
  plateId: string,
  result: Exclude<KitBitQcResult, "pending">,
): ShopDryRun {
  const plate = shop.plates.find((item) => item.id === plateId);
  if (!plate || plate.status !== "pending_qc") return shop;
  let next = shop;
  for (const row of plate.bits) {
    next = setPlateBitResult(next, plateId, row.orderId, row.bitId, result);
  }
  return next;
}

/**
 * After physical inspection: good → done on that order; reprint → back to pool.
 */
export function completePlateQc(
  shop: ShopDryRun,
  plateId: string,
  now: Date = new Date(),
): { shop: ShopDryRun; ok: true } | { shop: ShopDryRun; ok: false; error: string } {
  const plate = shop.plates.find((item) => item.id === plateId);
  if (!plate) return { shop, ok: false, error: "Plate not found" };
  if (plate.status !== "pending_qc") return { shop, ok: false, error: "Plate already inspected" };
  const pending = plate.bits.filter((row) => row.result === "pending");
  if (pending.length > 0) {
    return { shop, ok: false, error: `Inspect all bits first (${pending.length} still unmarked).` };
  }

  let next: ShopDryRun = {
    ...shop,
    plates: shop.plates.map((item) =>
      item.id === plateId ? { ...item, status: "inspected", inspectedAt: now.toISOString() } : item,
    ),
  };

  for (const row of plate.bits) {
    if (row.result === "good") {
      next = updateOrderBit(next, row.orderId, row.bitId, { status: "done", plateId });
    } else if (row.result === "reprint") {
      // Back to pool — not a plate until operator creates one from the pool.
      next = updateOrderBit(next, row.orderId, row.bitId, { status: "needs_reprint", plateId: null });
    }
  }

  return { shop: next, ok: true };
}

export function resetShop(shop: ShopDryRun): ShopDryRun {
  return {
    orders: shop.orders.map((order) => ({
      ...order,
      bits: order.bits.map((bit) => ({ ...bit, status: "todo" as const, plateId: null })),
    })),
    plates: [],
  };
}

export function replaceOrderKit(shop: ShopDryRun, orderId: string, bits: KitBit[]): ShopDryRun {
  return {
    ...shop,
    orders: shop.orders.map((order) => (order.id === orderId ? { ...order, bits } : order)),
    plates: shop.plates.filter((plate) => !plate.bits.some((row) => row.orderId === orderId)),
  };
}

/** @deprecated keep name for older tests — prefer createSampleShop */
export function createAcastusDryRunKit(): ShopDryRun {
  return createSampleShop();
}
