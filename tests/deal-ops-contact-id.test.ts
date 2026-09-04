import test from "node:test";
import assert from "node:assert/strict";
import { hubspotObjectId } from "../server/lib/deal-ops";

test("hubspotObjectId accepts string and numeric association ids", () => {
  assert.equal(hubspotObjectId("531009963717"), "531009963717");
  assert.equal(hubspotObjectId(531009963717), "531009963717");
  assert.equal(hubspotObjectId(" 342134173423 "), "342134173423");
  assert.equal(hubspotObjectId(null), null);
  assert.equal(hubspotObjectId(""), null);
  assert.equal(hubspotObjectId("abc"), null);
  assert.equal(hubspotObjectId(-1), null);
});
