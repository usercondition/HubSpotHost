/**
 * Simple kit tracker: bit inventory + plates.
 * Needed → on a plate → mark good or reprint → reprint goes back to needed.
 */

export type BitStatus = "needed" | "on_plate" | "good" | "reprint";

export type KitBit = {
  id: string;
  fileName: string;
  label: string;
  group: string;
  status: BitStatus;
  /** Current plate, when status is on_plate. */
  plateId: string | null;
};

export type KitPlate = {
  id: string;
  name: string;
  ctbFileName: string;
  createdAt: string;
  bitIds: string[];
};

export type KitTracker = {
  name: string;
  bits: KitBit[];
  plates: KitPlate[];
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
      status: "needed",
      plateId: null,
    });
  }
  return bits;
}

export function buildKitBitsFromFileNames(files: string[], idPrefix = "kit"): KitBit[] {
  return bitsFromFileList(files, idPrefix.replace(/\W+/g, "-").toLowerCase() || "kit");
}

export function createSampleKit(): KitTracker {
  return {
    name: "Acastus Knight Porphyrion",
    bits: bitsFromFileList(ACASTUS_FILES, "acastus"),
    plates: [],
  };
}

export function createKitFromBits(name: string, bits: KitBit[]): KitTracker {
  return {
    name: name.trim() || "Imported kit",
    bits,
    plates: [],
  };
}

/** Bits that still need a print pass (never printed, or marked reprint). */
export function isPrintable(bit: KitBit): boolean {
  return bit.status === "needed" || bit.status === "reprint";
}

export function inventory(kit: KitTracker): {
  needed: number;
  reprint: number;
  onPlate: number;
  good: number;
  total: number;
  remaining: number;
} {
  const needed = kit.bits.filter((bit) => bit.status === "needed").length;
  const reprint = kit.bits.filter((bit) => bit.status === "reprint").length;
  const onPlate = kit.bits.filter((bit) => bit.status === "on_plate").length;
  const good = kit.bits.filter((bit) => bit.status === "good").length;
  return {
    needed,
    reprint,
    onPlate,
    good,
    total: kit.bits.length,
    remaining: needed + reprint,
  };
}

export function groupSummaries(kit: KitTracker): Array<{
  group: string;
  good: number;
  remaining: number;
  total: number;
}> {
  const map = new Map<string, { good: number; remaining: number; total: number }>();
  for (const bit of kit.bits) {
    const row = map.get(bit.group) ?? { good: 0, remaining: 0, total: 0 };
    row.total += 1;
    if (bit.status === "good") row.good += 1;
    if (isPrintable(bit)) row.remaining += 1;
    map.set(bit.group, row);
  }
  return Array.from(map.entries())
    .map(([group, counts]) => ({ group, ...counts }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

export function createPlate(
  kit: KitTracker,
  input: { name: string; ctbFileName: string; bitIds: string[] },
): { ok: true; kit: KitTracker; plateId: string } | { ok: false; error: string } {
  const name = input.name.trim() || "Plate";
  const ctbFileName = input.ctbFileName.trim() || `${name.replace(/\s+/g, "_")}.ctb`;
  const uniqueIds = Array.from(new Set(input.bitIds));
  if (uniqueIds.length === 0) return { ok: false, error: "Select at least one bit that still needs printing." };

  const bitMap = new Map(kit.bits.map((bit) => [bit.id, bit]));
  for (const id of uniqueIds) {
    const bit = bitMap.get(id);
    if (!bit) return { ok: false, error: "One of the selected bits is missing from this kit." };
    if (!isPrintable(bit)) {
      return { ok: false, error: `${bit.label} is already on a plate or marked good.` };
    }
  }

  const plateId = `plate-${kit.plates.length + 1}-${Date.now().toString(36)}`;
  const plate: KitPlate = {
    id: plateId,
    name,
    ctbFileName,
    createdAt: new Date().toISOString(),
    bitIds: uniqueIds,
  };

  return {
    ok: true,
    plateId,
    kit: {
      ...kit,
      plates: [...kit.plates, plate],
      bits: kit.bits.map((bit) =>
        uniqueIds.includes(bit.id) ? { ...bit, status: "on_plate", plateId } : bit,
      ),
    },
  };
}

export function markBitGood(
  kit: KitTracker,
  bitId: string,
): { ok: true; kit: KitTracker } | { ok: false; error: string } {
  const bit = kit.bits.find((item) => item.id === bitId);
  if (!bit) return { ok: false, error: "Bit not found." };
  if (bit.status !== "on_plate") return { ok: false, error: "Only bits currently on a plate can be marked good." };
  return {
    ok: true,
    kit: {
      ...kit,
      bits: kit.bits.map((item) =>
        item.id === bitId ? { ...item, status: "good", plateId: item.plateId } : item,
      ),
    },
  };
}

export function markBitReprint(
  kit: KitTracker,
  bitId: string,
): { ok: true; kit: KitTracker } | { ok: false; error: string } {
  const bit = kit.bits.find((item) => item.id === bitId);
  if (!bit) return { ok: false, error: "Bit not found." };
  if (bit.status !== "on_plate" && bit.status !== "good") {
    return { ok: false, error: "Only printed bits can be sent back for reprint." };
  }
  return {
    ok: true,
    kit: {
      ...kit,
      bits: kit.bits.map((item) =>
        item.id === bitId ? { ...item, status: "reprint", plateId: null } : item,
      ),
    },
  };
}

export function markPlateAllGood(
  kit: KitTracker,
  plateId: string,
): { ok: true; kit: KitTracker; count: number } | { ok: false; error: string } {
  const plate = kit.plates.find((item) => item.id === plateId);
  if (!plate) return { ok: false, error: "Plate not found." };
  const onPlate = kit.bits.filter((bit) => bit.plateId === plateId && bit.status === "on_plate");
  if (onPlate.length === 0) return { ok: false, error: "No bits left to mark on this plate." };
  let next = kit;
  for (const bit of onPlate) {
    const result = markBitGood(next, bit.id);
    if (!result.ok) return result;
    next = result.kit;
  }
  return { ok: true, kit: next, count: onPlate.length };
}

export function plateBits(kit: KitTracker, plateId: string): KitBit[] {
  const plate = kit.plates.find((item) => item.id === plateId);
  if (!plate) return [];
  const map = new Map(kit.bits.map((bit) => [bit.id, bit]));
  return plate.bitIds.map((id) => map.get(id)).filter((bit): bit is KitBit => Boolean(bit));
}
