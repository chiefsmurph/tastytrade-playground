import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getAccountBalanceNumber, getEffectiveTotalCapital } from "../account-balance";
import { normalizeAccountBalance, normalizePositions } from "../normalize";

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"),
  ) as T;
}

test("normalizes broker positions into camelCase strategy shape", () => {
  const positions = normalizePositions(readFixture<unknown[]>("positions.json"));

  assert.equal(positions[0].symbol, "RUM   260717C00010000");
  assert.equal(positions[0].orderSymbol, "RUM   260717C00010000");
  assert.equal(positions[0].quoteSymbol, "./RUM260717C10");
  assert.equal(positions[0].underlyingSymbol, "RUM");
  assert.equal(positions[0].instrumentType, "Equity Option");
  assert.equal(positions[0].quantityDirection, "Long");
  assert.equal(positions[0].averageOpenPrice, 1.25);
  assert.equal(positions[0].multiplier, 100);
  assert.deepEqual(positions[0].normalizationErrors, []);
});

test("normalizes broker balances and preserves numeric helper behavior", () => {
  const balance = normalizeAccountBalance(readFixture("balances.json"));

  assert.equal(
    getAccountBalanceNumber(balance, "derivative_buying_power", "derivative-buying-power"),
    25000,
  );
  assert.equal(getEffectiveTotalCapital(balance), 100250);
});
