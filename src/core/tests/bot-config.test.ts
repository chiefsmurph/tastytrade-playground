import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { reloadBotConfig } from "../bot-config";

test("bot config applies selected profile before top-level overrides", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "john-trading-profile-"));
  const configPath = path.join(dir, "trading-bot.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      environment: "sandbox",
      profile: "balanced",
      profiles: {
        balanced: {
          strategy: {
            allowDteFallback: true,
            maxLossForNewAllocationPct: -0.08,
          },
          liquidity: {
            minDayVolume: 80,
          },
        },
      },
      strategy: {
        allowDteFallback: false,
      },
    }),
    "utf8",
  );

  process.env.TASTYTRADE_BOT_CONFIG = configPath;
  const config = reloadBotConfig();

  assert.equal(config.profile, "balanced");
  assert.equal(config.liquidity.minDayVolume, 80);
  assert.equal(config.strategy.maxLossForNewAllocationPct, -0.08);
  assert.equal(config.strategy.allowDteFallback, false);

  delete process.env.TASTYTRADE_BOT_CONFIG;
  reloadBotConfig();
});

test("bot config reload refuses runtime environment switches", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "john-trading-env-switch-"));
  const sandboxPath = path.join(dir, "sandbox.json");
  const productionPath = path.join(dir, "production.json");
  writeFileSync(sandboxPath, JSON.stringify({ environment: "sandbox" }), "utf8");
  writeFileSync(
    productionPath,
    JSON.stringify({ environment: "production" }),
    "utf8",
  );

  process.env.TASTYTRADE_BOT_CONFIG = sandboxPath;
  assert.equal(reloadBotConfig().environment, "sandbox");

  process.env.TASTYTRADE_BOT_CONFIG = productionPath;
  assert.throws(
    () => reloadBotConfig(),
    /Refusing runtime environment switch from sandbox to production/,
  );

  process.env.TASTYTRADE_BOT_CONFIG = sandboxPath;
  reloadBotConfig();
  delete process.env.TASTYTRADE_BOT_CONFIG;
  reloadBotConfig();
});
