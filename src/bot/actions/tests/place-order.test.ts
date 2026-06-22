import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.API_CLIENT_SECRET = "test-secret";
process.env.API_REFRESH_TOKEN = "test-refresh";
delete process.env.BOT_ENABLE_LIVE_ORDERS;

function buildOrder() {
  return {
    source: "tastytrade-playground",
    "time-in-force": "Day" as const,
    "order-type": "Limit" as const,
    price: "1.00",
    "price-effect": "Debit" as const,
    legs: [
      {
        action: "Buy to Open",
        symbol: "RUM   260717C00010000",
        quantity: 1,
        "instrument-type": "Equity Option",
      },
    ],
  };
}

function writeTempConfig(liveEnabled: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), "john-trading-config-"));
  const configPath = path.join(dir, "trading-bot.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      environment: "sandbox",
      liveOrders: {
        enabled: liveEnabled,
        requireEnvFlag: true,
        alwaysDryRunFirst: true,
      },
    }),
    "utf8",
  );
  return configPath;
}

test("placeOrderSafely dry-runs but does not submit when live interlock is disabled", async () => {
  const { default: tastytradeApi } = await import("../../../core/tastytrade-client");
  const { reloadBotConfig } = await import("../../../core/bot-config");
  const { placeOrderSafely } = await import("../place-order");

  delete process.env.TASTYTRADE_BOT_CONFIG;
  delete process.env.BOT_ENABLE_LIVE_ORDERS;
  reloadBotConfig();

  const dryRun = mock.method(
    tastytradeApi.orderService,
    "postOrderDryRun",
    async () => ({ ok: true }),
  );
  const createOrder = mock.method(
    tastytradeApi.orderService,
    "createOrder",
    async () => ({ id: 1 }),
  );

  const result = await placeOrderSafely("ACCT-REDACTED-1234", buildOrder());

  assert.equal(dryRun.mock.callCount(), 1);
  assert.equal(createOrder.mock.callCount(), 0);
  assert.equal(result.dryRunPassed, true);
  assert.equal(result.submitted, false);
  assert.match(result.skippedReason ?? "", /live orders disabled/);
});

test("placeOrderSafely returns a structured skip when dry-run fails", async () => {
  const { default: tastytradeApi } = await import("../../../core/tastytrade-client");
  const { reloadBotConfig } = await import("../../../core/bot-config");
  const { placeOrderSafely } = await import("../place-order");

  delete process.env.TASTYTRADE_BOT_CONFIG;
  delete process.env.BOT_ENABLE_LIVE_ORDERS;
  reloadBotConfig();

  const dryRun = mock.method(
    tastytradeApi.orderService,
    "postOrderDryRun",
    async () => {
      throw new Error("dry-run rejected");
    },
  );
  const createOrder = mock.method(
    tastytradeApi.orderService,
    "createOrder",
    async () => ({ id: 1 }),
  );

  const result = await placeOrderSafely("ACCT-REDACTED-1234", buildOrder());

  assert.equal(dryRun.mock.callCount(), 1);
  assert.equal(createOrder.mock.callCount(), 0);
  assert.equal(result.dryRunPassed, false);
  assert.equal(result.submitted, false);
  assert.match(result.skippedReason ?? "", /dry-run rejected/);
});

test("placeOrderSafely submits only when config and env live interlocks are both enabled", async () => {
  const { default: tastytradeApi } = await import("../../../core/tastytrade-client");
  const { reloadBotConfig } = await import("../../../core/bot-config");
  const { placeOrderSafely } = await import("../place-order");

  process.env.TASTYTRADE_BOT_CONFIG = writeTempConfig(true);
  process.env.BOT_ENABLE_LIVE_ORDERS = "true";
  reloadBotConfig();

  const dryRun = mock.method(
    tastytradeApi.orderService,
    "postOrderDryRun",
    async () => ({ ok: true }),
  );
  const createOrder = mock.method(
    tastytradeApi.orderService,
    "createOrder",
    async () => ({ id: 123 }),
  );

  const result = await placeOrderSafely("ACCT-REDACTED-1234", buildOrder());

  assert.equal(dryRun.mock.callCount(), 1);
  assert.equal(createOrder.mock.callCount(), 1);
  assert.equal(result.dryRunPassed, true);
  assert.equal(result.submitted, true);
  assert.deepEqual(result.orderResponse, { id: 123 });

  delete process.env.TASTYTRADE_BOT_CONFIG;
  delete process.env.BOT_ENABLE_LIVE_ORDERS;
  reloadBotConfig();
});
