/**
 * Client-only kit dry-run helpers. No HubSpot / SQLite writes.
 *
 * Flow:
 * 1) Select bits + attach plate/CTB → bits are "printing", plate is pending QC
 * 2) After physical print + visual inspection → mark each bit good or reprint
 * 3) Reprints return to the queue for a later plate
 */

export type KitBitStatus = "todo" | "printing" | "done" | "needs_reprint";

export type KitBitQcResult = "pending" | "good" | "reprint";

export type KitPlateStatus = "pending_qc" | "inspected";

export type KitBit = {
  id: string;
  fileName: string;
  label: string;
  group: string;
  status: KitBitStatus;
  /** Latest plate this bit was assigned to (printing or completed). */
  plateId: string | null;
};

export type KitPlateBit = {
  bitId: string;
  result: KitBitQcResult;
};

export type KitPlate = {
  id: string;
  name: string;
  /** Simulated CTB filename for the dry run. */
  ctbFileName: string;
  attachedAt: string;
  inspectedAt: string | null;
  status: KitPlateStatus;
  bits: KitPlateBit[];
};

export type KitDryRun = {
  name: string;
  sourceNote: string;
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
  if (/head|face/.test(lower)) return "Head";
  if (/leg|thigh|foot|toe|hip|waist/.test(lower)) return "Waist / legs";
  if (/arm|barrel|manifold|shield/.test(lower)) return "Arm weapons";
  if (/shoulder|cannon|lascannon/.test(lower)) return "Shoulders / secondaries";
  if (/torso|interior|gorget|throne/.test(lower)) return "Torso / interior";
  return "Other";
}

export function labelFromFileName(fileName: string): string {
  return fileName.replace(/\.stl$/i, "").trim();
}

export function parseKitFileList(
  raw: string,
  options?: { kitName?: string; sourceNote?: string },
): KitDryRun {
  const seen = new Set<string>();
  const bits: KitBit[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const fileName = line.trim().replace(/^["']|["']$/g, "");
    if (!fileName || fileName.startsWith("#")) continue;
    if (!/\.stl$/i.test(fileName) && !/^[0-9]/.test(fileName)) continue;
    const normalized = /\.stl$/i.test(fileName) ? fileName : `${fileName}.stl`;
    const base = normalized.split(/[/\\]/).pop() || normalized;
    const key = base.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bits.push({
      id: `bit-${bits.length + 1}-${key.replace(/[^a-z0-9]+/g, "-")}`,
      fileName: base,
      label: labelFromFileName(base),
      group: groupForFileName(base),
      status: "todo",
      plateId: null,
    });
  }

  return {
    name: options?.kitName?.trim() || "Imported kit",
    sourceNote: options?.sourceNote?.trim() || "Pasted STL list",
    bits,
    plates: [],
  };
}

export function createAcastusDryRunKit(): KitDryRun {
  return parseKitFileList(ACASTUS_FILES.join("\n"), {
    kitName: "Acastus Knight Porphyrion",
    sourceNote: "STLHammer sample · dry run only (not saved to HubSpot)",
  });
}

export function isSelectableBit(bit: KitBit): boolean {
  return bit.status === "todo" || bit.status === "needs_reprint";
}

export function kitProgress(kit: KitDryRun): {
  done: number;
  total: number;
  printing: number;
  reprint: number;
  todo: number;
  remaining: number;
} {
  const total = kit.bits.length;
  const done = kit.bits.filter((bit) => bit.status === "done").length;
  const printing = kit.bits.filter((bit) => bit.status === "printing").length;
  const reprint = kit.bits.filter((bit) => bit.status === "needs_reprint").length;
  const todo = kit.bits.filter((bit) => bit.status === "todo").length;
  return {
    done,
    total,
    printing,
    reprint,
    todo,
    remaining: total - done,
  };
}

export function groupSummaries(kit: KitDryRun): Array<{
  group: string;
  done: number;
  total: number;
  printing: number;
  reprint: number;
}> {
  const map = new Map<string, { done: number; total: number; printing: number; reprint: number }>();
  for (const bit of kit.bits) {
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

/**
 * Attach a sliced plate: bits move to "printing" and wait for post-print QC.
 * Does not mark bits done — inspection comes later.
 */
export function attachBitsToPlate(
  kit: KitDryRun,
  input: { plateName: string; ctbFileName?: string; bitIds: string[] },
  now: Date = new Date(),
): KitDryRun {
  const uniqueIds = Array.from(new Set(input.bitIds)).filter((id) =>
    kit.bits.some((bit) => bit.id === id && isSelectableBit(bit)),
  );
  if (uniqueIds.length === 0) return kit;

  const plateNumber = kit.plates.length + 1;
  const plateId = `plate-${plateNumber}-${now.getTime()}`;
  const plateName = input.plateName.trim() || `Plate ${plateNumber}`;
  const ctbFileName =
    input.ctbFileName?.trim() ||
    `${plateName.replace(/[^\w.-]+/g, "_")}.ctb`;

  const plate: KitPlate = {
    id: plateId,
    name: plateName,
    ctbFileName,
    attachedAt: now.toISOString(),
    inspectedAt: null,
    status: "pending_qc",
    bits: uniqueIds.map((bitId) => ({ bitId, result: "pending" })),
  };

  const idSet = new Set(uniqueIds);
  return {
    ...kit,
    plates: [plate, ...kit.plates],
    bits: kit.bits.map((bit) =>
      idSet.has(bit.id) ? { ...bit, status: "printing", plateId } : bit,
    ),
  };
}

export function setPlateBitResult(
  kit: KitDryRun,
  plateId: string,
  bitId: string,
  result: Exclude<KitBitQcResult, "pending">,
): KitDryRun {
  return {
    ...kit,
    plates: kit.plates.map((plate) => {
      if (plate.id !== plateId || plate.status !== "pending_qc") return plate;
      return {
        ...plate,
        bits: plate.bits.map((row) => (row.bitId === bitId ? { ...row, result } : row)),
      };
    }),
  };
}

export function markAllPlateBits(
  kit: KitDryRun,
  plateId: string,
  result: Exclude<KitBitQcResult, "pending">,
): KitDryRun {
  const plate = kit.plates.find((item) => item.id === plateId);
  if (!plate || plate.status !== "pending_qc") return kit;
  let next = kit;
  for (const row of plate.bits) {
    next = setPlateBitResult(next, plateId, row.bitId, result);
  }
  return next;
}

/**
 * Finalize QC after physical inspection. Good bits → done.
 * Reprint bits → needs_reprint (selectable again). Pending not allowed.
 */
export function completePlateQc(
  kit: KitDryRun,
  plateId: string,
  now: Date = new Date(),
): { kit: KitDryRun; ok: true } | { kit: KitDryRun; ok: false; error: string } {
  const plate = kit.plates.find((item) => item.id === plateId);
  if (!plate) return { kit, ok: false, error: "Plate not found" };
  if (plate.status !== "pending_qc") return { kit, ok: false, error: "Plate already inspected" };

  const pending = plate.bits.filter((row) => row.result === "pending");
  if (pending.length > 0) {
    return {
      kit,
      ok: false,
      error: `Inspect all bits first (${pending.length} still unmarked).`,
    };
  }

  const resultByBit = new Map(plate.bits.map((row) => [row.bitId, row.result]));
  return {
    ok: true,
    kit: {
      ...kit,
      plates: kit.plates.map((item) =>
        item.id === plateId
          ? { ...item, status: "inspected", inspectedAt: now.toISOString() }
          : item,
      ),
      bits: kit.bits.map((bit) => {
        const result = resultByBit.get(bit.id);
        if (!result || bit.plateId !== plateId) return bit;
        if (result === "good") return { ...bit, status: "done", plateId };
        if (result === "reprint") return { ...bit, status: "needs_reprint", plateId: null };
        return bit;
      }),
    },
  };
}

export function resetKitProgress(kit: KitDryRun): KitDryRun {
  return {
    ...kit,
    plates: [],
    bits: kit.bits.map((bit) => ({ ...bit, status: "todo", plateId: null })),
  };
}
