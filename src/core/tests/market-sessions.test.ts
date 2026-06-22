import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isEquityOptionsMarketOpen,
  parseCurrentEquitiesSession,
} from "../market-sessions";

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"),
  );
}

test("market session parser reads official fields and ignores extended close", () => {
  const session = parseCurrentEquitiesSession(
    readFixture("market-session-current.json"),
    new Date("2026-06-19T18:00:00.000Z"),
  );

  assert.equal(session.opensAt, "2026-06-19T13:30:00.000Z");
  assert.equal(session.closesAt, "2026-06-19T20:00:00.000Z");
  assert.equal(session.closeAtExt, "2026-06-20T00:00:00.000Z");
  assert.equal(session.isOpen, true);
  assert.equal(isEquityOptionsMarketOpen(session), true);

  const afterRegularClose = parseCurrentEquitiesSession(
    readFixture("market-session-current.json"),
    new Date("2026-06-19T21:00:00.000Z"),
  );
  assert.equal(afterRegularClose.isOpen, false);
  assert.equal(isEquityOptionsMarketOpen(afterRegularClose), false);
});

test("market session parser fails closed on malformed payloads", () => {
  const session = parseCurrentEquitiesSession({ data: { data: {} } });

  assert.equal(session.isOpen, false);
  assert.equal(isEquityOptionsMarketOpen(session), false);
});
