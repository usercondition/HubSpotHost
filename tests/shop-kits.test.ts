import test from "node:test";
import assert from "node:assert/strict";
import { assignKits, copyKey, partOrder, type KitInputRow } from "../shared/shop-kits";

const f = (id: string, path: string, name: string, size: number, files: number): KitInputRow => ({ id, name, category: "folder", path, size, files });
const z = (id: string, path: string, name: string, size: number): KitInputRow => ({ id, name, category: "archive", path, size, files: null });

test("copyKey strips copy markers", () => {
  assert.equal(copyKey("Ragegutta Mega Armor (2)"), "ragegutta mega armor");
  assert.equal(copyKey("Knight Castellan - Copy"), "knight castellan");
  assert.equal(copyKey("Copy of Knight Castellan.zip"), "knight castellan");
  assert.equal(copyKey("Knight Castellan @STLHammer"), "knight castellan @stlhammer");
});

test("part folders of a kit fold into one card; copies across drives share it", () => {
  const rows: KitInputRow[] = [
    f("rg2", "X:", "Ragegutta Mega Armor (2)", 328656133, 80),
    f("rg", "X:/Ragegutta Mega Armor (2)", "Ragegutta Mega Armor", 328655893, 79),
    f("rgS", "X:/Ragegutta Mega Armor (2)/Ragegutta Mega Armor", "Supported", 161924348, 22),
    f("rgU", "X:/Ragegutta Mega Armor (2)/Ragegutta Mega Armor", "Unsupported", 102492748, 22),
    f("rgSB", "X:/Ragegutta Mega Armor (2)/Ragegutta Mega Armor/Supported", "Body", 49299236, 4),
    f("rgUL", "X:/Ragegutta Mega Armor (2)/Ragegutta Mega Armor/Unsupported", "LeftArm", 16383768, 2),
    z("rgz", "X:", "Ragegutta Mega Armor (2).zip", 203120757),
    f("kcX", "X:", "Knight Castellan @STLHammer", 448401777, 97),
    f("kcXi", "X:/Knight Castellan @STLHammer", "Knight Castellan @STLHammer", 448401777, 97),
    f("kcZ", "Z:", "Knight Castellan @STLHammer", 448401777, 97),
    f("kcZi", "Z:/Knight Castellan @STLHammer", "Knight Castellan @STLHammer", 448401777, 97),
    f("k1", "Z:", "Knight Castellan", 2727210524, 149),
    f("k2", "Z:", "Knight Castellan (2)", 2727210524, 149),
    f("k3", "Z:", "Knight Castellan (3)", 2727210524, 149),
    f("k3a", "Z:/Knight Castellan (3)/Knight Castellan", "Arms", 90594800, 25),
    f("k3i", "Z:/Knight Castellan (3)", "Knight Castellan", 2727210524, 149),
    z("k1z", "Z:", "Knight Castellan.zip", 1875561521),
    f("lib", "Z:", "BTDLS", 9_000_000_000, 20000),
    f("libk", "Z:/BTDLS", "Ground Plunderer", 50_000_000, 40),
    f("libkd", "Z:/BTDLS/Ground Plunderer", "Doors", 5_000_000, 6),
  ];
  const a = assignKits(rows);
  const grp = (id: string) => a.get(id)!.grp;
  for (const id of ["rg2", "rg", "rgS", "rgU", "rgSB", "rgUL", "rgz"]) assert.equal(grp(id), "rg2", id);
  for (const id of ["kcX", "kcXi", "kcZ", "kcZi"]) assert.equal(grp(id), "kcX", id);
  assert.equal(a.get("kcX")!.copies, 2);
  for (const id of ["k1", "k2", "k3", "k3a", "k3i", "k1z"]) assert.equal(grp(id), "k1", id);
  assert.equal(a.get("k1")!.copies, 4); // 3 folders + the zip
  assert.equal(grp("libkd"), "libk"); // big container skipped
  const cards = new Set(rows.map((r) => grp(r.id)));
  assert.deepEqual([...cards].sort(), ["k1", "kcX", "lib", "libk", "rg2"].sort());
});

test("Supported/Unsupported sort first", () => {
  assert.deepEqual(["Body", "Unsupported", "Supported"].sort((x, y) => partOrder(x) - partOrder(y)), ["Supported", "Unsupported", "Body"]);
});
