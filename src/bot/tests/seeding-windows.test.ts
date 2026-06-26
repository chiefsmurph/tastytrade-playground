import test from "node:test";
import assert from "node:assert/strict";

import {
  getSecretAutoSeedTargetAccountType,
  getSecretAutoSeedMarginEndMinute,
  isWithinSecretAutoSeedWindow,
} from "../seeding-windows";

test("getSecretAutoSeedTargetAccountType switches from margin to cash at 12:15 by default", () => {
  assert.equal(
    getSecretAutoSeedTargetAccountType(new Date("2026-06-24T12:14:00")),
    "margin",
  );
  assert.equal(
    getSecretAutoSeedTargetAccountType(new Date("2026-06-24T12:15:00")),
    "cash",
  );
});

test("isWithinSecretAutoSeedWindow stays open through 13:00", () => {
  assert.equal(
    isWithinSecretAutoSeedWindow(new Date("2026-06-24T12:59:00")),
    true,
  );
  assert.equal(
    isWithinSecretAutoSeedWindow(new Date("2026-06-24T13:00:00")),
    true,
  );
  assert.equal(
    isWithinSecretAutoSeedWindow(new Date("2026-06-24T13:01:00")),
    false,
  );
});

test("getSecretAutoSeedMarginEndMinute prefers the renamed env var", () => {
  const previousNewValue = process.env.SECRET_AUTO_SEED_MARGIN_END_TIME;
  const previousOldValue = process.env.SECRET_AUTO_SEED_END_TIME;
  process.env.SECRET_AUTO_SEED_MARGIN_END_TIME = "12:45";
  process.env.SECRET_AUTO_SEED_END_TIME = "12:30";

  try {
    assert.equal(getSecretAutoSeedMarginEndMinute(), 12 * 60 + 45);
  } finally {
    if (previousNewValue === undefined) {
      delete process.env.SECRET_AUTO_SEED_MARGIN_END_TIME;
    } else {
      process.env.SECRET_AUTO_SEED_MARGIN_END_TIME = previousNewValue;
    }

    if (previousOldValue === undefined) {
      delete process.env.SECRET_AUTO_SEED_END_TIME;
    } else {
      process.env.SECRET_AUTO_SEED_END_TIME = previousOldValue;
    }
  }
});