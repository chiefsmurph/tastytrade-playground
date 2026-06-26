import test from "node:test";
import assert from "node:assert/strict";

import { isWithinCashAccountSeedDteRange } from "../seed-symbol";

test("isWithinCashAccountSeedDteRange enforces 14-30 inclusive", () => {
  assert.equal(isWithinCashAccountSeedDteRange(13), false);
  assert.equal(isWithinCashAccountSeedDteRange(14), true);
  assert.equal(isWithinCashAccountSeedDteRange(21), true);
  assert.equal(isWithinCashAccountSeedDteRange(30), true);
  assert.equal(isWithinCashAccountSeedDteRange(31), false);
  assert.equal(isWithinCashAccountSeedDteRange(undefined), false);
  assert.equal(isWithinCashAccountSeedDteRange(null), false);
});
