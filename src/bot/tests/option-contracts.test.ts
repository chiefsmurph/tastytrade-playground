import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { OptionChainWithVolumes } from "../../core/types";
import {
  chooseOptionCandidates,
  meetsLiquidityRequirement,
} from "../option-contracts";

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../core/__fixtures__/${name}`, import.meta.url), "utf8"),
  ) as T;
}

test("call candidates use call OCC order symbol and call streamer quote symbol", () => {
  const chain = readFixture<OptionChainWithVolumes>("option-chain.json");
  const [candidate] = chooseOptionCandidates(chain, 11, "call", {
    minDTE: 28,
    maxDTE: 42,
  });

  assert.equal(candidate.side, "call");
  assert.equal(candidate.orderSymbol, "RUM   260717C00010000");
  assert.equal(candidate.quoteSymbol, "./RUM260717C10");
  assert.equal(candidate.dayVolume, 200);
  assert.equal(meetsLiquidityRequirement(candidate), true);
});

test("put candidates use put OCC order symbol and put streamer quote symbol", () => {
  const chain = readFixture<OptionChainWithVolumes>("option-chain.json");
  const [candidate] = chooseOptionCandidates(chain, 11, "put", {
    minDTE: 28,
    maxDTE: 42,
  });

  assert.equal(candidate.side, "put");
  assert.equal(candidate.orderSymbol, "RUM   260717P00012000");
  assert.equal(candidate.quoteSymbol, "./RUM260717P12");
  assert.equal(candidate.dayVolume, 160);
  assert.equal(meetsLiquidityRequirement(candidate), true);
});
