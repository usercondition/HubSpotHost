import test from "node:test";
import assert from "node:assert/strict";
import { stlPlateGlb } from "../server/lib/stl-plate-mesh";

test("source STL GLB retains a real plate footprint and centers the model on it", () => {
  const stl = Buffer.from(`
solid plate
 facet normal 0 0 1
  outer loop
   vertex 0 0 0
   vertex 10 0 0
   vertex 0 20 0
  endloop
 endfacet
endsolid plate`);
  const glb = stlPlateGlb(stl, { plateMmX: 220, plateMmY: 130, centerX: 150, centerY: 40 });
  assert.equal(glb.subarray(0, 4).toString(), "glTF");
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString().trim()) as { nodes: Array<{ extras: { plate: number[]; source: string } }> };
  assert.deepEqual(json.nodes[0]?.extras.plate, [220, 130]);
  assert.equal(json.nodes[0]?.extras.source, "stl");
});
