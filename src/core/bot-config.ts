import fs from "node:fs";
import path from "node:path";

export type TradingEnvironment = "sandbox" | "production";
export type CostBasisUnit = "perShare" | "perContract";
export type AllocationPriority = "underweightThenBestReturn" | "bestReturn";
export type LiquidationMode = "marketableLimit" | "weightedLimit";
export type OptionSide = "call" | "put";
export type BotConfigProfile = "conservative" | "balanced" | "aggressive" | string;

export interface BotConfig {
  environment: TradingEnvironment;
  profile?: BotConfigProfile;
  profiles?: Record<string, PartialBotConfig>;
  liveOrders: {
    enabled: boolean;
    requireEnvFlag: boolean;
    alwaysDryRunFirst: boolean;
  };
  strategy: {
    timezone: string;
    enabledSides: OptionSide[];
    allocationPriority: AllocationPriority;
    allowAddingToLosingPositions: boolean;
    maxLossForNewAllocationPct: number;
    allowDteFallback: boolean;
    marketOpenTime: string;
    allocationCutoffTime: string;
    liquidationTime: string;
    costBasisUnit: CostBasisUnit;
  };
  liquidity: {
    minDayVolume: number;
    minOpenInterest: number;
  };
  liquidation: {
    mode: LiquidationMode;
    slippageTicks: number;
  };
  scheduler: {
    openIntervalMs: number;
    closedIntervalMs: number;
  };
  logging: {
    redactAccountNumbers: boolean;
    logRawBrokerPayloads: boolean;
  };
}

export type PartialBotConfig = {
  [K in keyof BotConfig]?: BotConfig[K] extends Record<string, unknown>
    ? Partial<BotConfig[K]>
    : BotConfig[K];
};

export const DEFAULT_BOT_CONFIG: BotConfig = {
  environment: "sandbox",
  profile: "conservative",
  liveOrders: {
    enabled: false,
    requireEnvFlag: true,
    alwaysDryRunFirst: true,
  },
  strategy: {
    timezone: "America/Los_Angeles",
    enabledSides: ["call", "put"],
    allocationPriority: "underweightThenBestReturn",
    allowAddingToLosingPositions: false,
    maxLossForNewAllocationPct: -0.05,
    allowDteFallback: false,
    marketOpenTime: "06:30",
    allocationCutoffTime: "12:30",
    liquidationTime: "12:55",
    costBasisUnit: "perShare",
  },
  liquidity: {
    minDayVolume: 120,
    minOpenInterest: 0,
  },
  liquidation: {
    mode: "marketableLimit",
    slippageTicks: 2,
  },
  scheduler: {
    openIntervalMs: 240_000,
    closedIntervalMs: 60_000,
  },
  logging: {
    redactAccountNumbers: true,
    logRawBrokerPayloads: false,
  },
};

let cachedConfig: BotConfig | null = null;
let runtimeLiveOrdersDisabledReason: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(override)) {
    return structuredClone(base);
  }

  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else if (overrideValue !== undefined) {
      result[key] = overrideValue;
    }
  }

  return result as T;
}

function readJsonConfig(configPath: string): unknown {
  const raw = fs.readFileSync(configPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid trading bot config JSON at ${configPath}: ${message}`);
  }
}

function omitProfiles(config: Record<string, unknown>): Record<string, unknown> {
  const { profiles, ...withoutProfiles } = config;
  return withoutProfiles;
}

function applySelectedProfile(rawConfig: unknown): unknown {
  if (!isRecord(rawConfig)) {
    return rawConfig;
  }

  const profileName =
    typeof rawConfig.profile === "string" && rawConfig.profile.trim()
      ? rawConfig.profile
      : undefined;
  const profiles = isRecord(rawConfig.profiles) ? rawConfig.profiles : undefined;
  const selectedProfile =
    profileName && profiles && isRecord(profiles[profileName])
      ? profiles[profileName]
      : undefined;

  if (!selectedProfile) {
    return rawConfig;
  }

  return deepMerge(
    deepMerge(DEFAULT_BOT_CONFIG, selectedProfile),
    omitProfiles(rawConfig),
  );
}

function normalizeNumber(value: unknown, fallback: number, min?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return min == null ? parsed : Math.max(min, parsed);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function validateConfig(config: BotConfig): BotConfig {
  const environment =
    config.environment === "production" || config.environment === "sandbox"
      ? config.environment
      : "sandbox";
  const enabledSides = config.strategy.enabledSides.filter(
    (side): side is OptionSide => side === "call" || side === "put",
  );

  return {
    ...config,
    environment,
    profile: config.profile ?? DEFAULT_BOT_CONFIG.profile,
    liveOrders: {
      enabled: normalizeBoolean(
        config.liveOrders.enabled,
        DEFAULT_BOT_CONFIG.liveOrders.enabled,
      ),
      requireEnvFlag: normalizeBoolean(
        config.liveOrders.requireEnvFlag,
        DEFAULT_BOT_CONFIG.liveOrders.requireEnvFlag,
      ),
      alwaysDryRunFirst: normalizeBoolean(
        config.liveOrders.alwaysDryRunFirst,
        DEFAULT_BOT_CONFIG.liveOrders.alwaysDryRunFirst,
      ),
    },
    strategy: {
      ...config.strategy,
      enabledSides: enabledSides.length > 0 ? enabledSides : ["call", "put"],
      allocationPriority:
        config.strategy.allocationPriority === "bestReturn"
          ? "bestReturn"
          : "underweightThenBestReturn",
      allowAddingToLosingPositions: normalizeBoolean(
        config.strategy.allowAddingToLosingPositions,
        DEFAULT_BOT_CONFIG.strategy.allowAddingToLosingPositions,
      ),
      maxLossForNewAllocationPct: normalizeNumber(
        config.strategy.maxLossForNewAllocationPct,
        DEFAULT_BOT_CONFIG.strategy.maxLossForNewAllocationPct,
      ),
      allowDteFallback: normalizeBoolean(
        config.strategy.allowDteFallback,
        DEFAULT_BOT_CONFIG.strategy.allowDteFallback,
      ),
      marketOpenTime: normalizeTimeOfDay(
        config.strategy.marketOpenTime,
        DEFAULT_BOT_CONFIG.strategy.marketOpenTime,
      ),
      allocationCutoffTime: normalizeTimeOfDay(
        config.strategy.allocationCutoffTime,
        DEFAULT_BOT_CONFIG.strategy.allocationCutoffTime,
      ),
      liquidationTime: normalizeTimeOfDay(
        config.strategy.liquidationTime,
        DEFAULT_BOT_CONFIG.strategy.liquidationTime,
      ),
      costBasisUnit:
        config.strategy.costBasisUnit === "perContract"
          ? "perContract"
          : "perShare",
      timezone: config.strategy.timezone || DEFAULT_BOT_CONFIG.strategy.timezone,
    },
    liquidity: {
      minDayVolume: normalizeNumber(
        config.liquidity.minDayVolume,
        DEFAULT_BOT_CONFIG.liquidity.minDayVolume,
        0,
      ),
      minOpenInterest: normalizeNumber(
        config.liquidity.minOpenInterest,
        DEFAULT_BOT_CONFIG.liquidity.minOpenInterest,
        0,
      ),
    },
    liquidation: {
      mode:
        config.liquidation.mode === "weightedLimit"
          ? "weightedLimit"
          : "marketableLimit",
      slippageTicks: normalizeNumber(
        config.liquidation.slippageTicks,
        DEFAULT_BOT_CONFIG.liquidation.slippageTicks,
        0,
      ),
    },
    scheduler: {
      openIntervalMs: normalizeNumber(
        config.scheduler.openIntervalMs,
        DEFAULT_BOT_CONFIG.scheduler.openIntervalMs,
        1,
      ),
      closedIntervalMs: normalizeNumber(
        config.scheduler.closedIntervalMs,
        DEFAULT_BOT_CONFIG.scheduler.closedIntervalMs,
        1,
      ),
    },
    logging: {
      redactAccountNumbers: normalizeBoolean(
        config.logging.redactAccountNumbers,
        DEFAULT_BOT_CONFIG.logging.redactAccountNumbers,
      ),
      logRawBrokerPayloads: normalizeBoolean(
        config.logging.logRawBrokerPayloads,
        DEFAULT_BOT_CONFIG.logging.logRawBrokerPayloads,
      ),
    },
  };
}

function normalizeTimeOfDay(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value.trim())
    ? value.trim()
    : fallback;
}

export function getBotConfigPath(): string {
  return (
    process.env.TASTYTRADE_BOT_CONFIG ||
    path.join(process.cwd(), "config", "trading-bot.config.json")
  );
}

export function loadBotConfig(): BotConfig {
  const configPath = getBotConfigPath();
  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULT_BOT_CONFIG);
  }

  return validateConfig(
    deepMerge(DEFAULT_BOT_CONFIG, applySelectedProfile(readJsonConfig(configPath))),
  );
}

export function getBotConfig(): BotConfig {
  cachedConfig ??= loadBotConfig();
  return cachedConfig;
}

export function reloadBotConfig(): BotConfig {
  const currentConfig = cachedConfig;
  const nextConfig = loadBotConfig();
  if (currentConfig && nextConfig.environment !== currentConfig.environment) {
    throw new Error(
      `Refusing runtime environment switch from ${currentConfig.environment} to ${nextConfig.environment}; restart the process instead`,
    );
  }

  cachedConfig = nextConfig;
  return cachedConfig;
}

export function disableLiveOrdersForProcess(reason = "runtime live-order kill switch active") {
  runtimeLiveOrdersDisabledReason = reason;
  process.env.BOT_ENABLE_LIVE_ORDERS = "false";
  return getRuntimeSafetyState();
}

export function getRuntimeSafetyState(config = getBotConfig()) {
  return {
    configPath: getBotConfigPath(),
    environment: config.environment,
    liveOrdersConfigured: config.liveOrders.enabled,
    liveOrdersEnvFlag: process.env.BOT_ENABLE_LIVE_ORDERS === "true",
    liveOrdersEnabled: isLiveOrderSubmissionEnabled(config),
    runtimeLiveOrdersDisabledReason,
    profile: config.profile,
  };
}

export function isLiveOrderSubmissionEnabled(config = getBotConfig()): boolean {
  if (runtimeLiveOrdersDisabledReason) {
    return false;
  }

  if (!config.liveOrders.enabled) {
    return false;
  }

  if (!config.liveOrders.requireEnvFlag) {
    return true;
  }

  return process.env.BOT_ENABLE_LIVE_ORDERS === "true";
}

export function getLiveOrderDisabledReason(config = getBotConfig()): string | undefined {
  if (runtimeLiveOrdersDisabledReason) {
    return runtimeLiveOrdersDisabledReason;
  }

  if (!config.liveOrders.enabled) {
    return "live orders disabled by config";
  }

  if (config.liveOrders.requireEnvFlag && process.env.BOT_ENABLE_LIVE_ORDERS !== "true") {
    return "live orders disabled because BOT_ENABLE_LIVE_ORDERS is not true";
  }

  return undefined;
}

export function formatStartupSafetyBanner(config = getBotConfig()): string {
  const runtimeState = getRuntimeSafetyState(config);
  const liveState = runtimeState.liveOrdersEnabled ? "ON" : "OFF";
  const env = config.environment.toUpperCase();

  return [
    "================ TASTYTRADE BOT SAFETY ================",
    `Environment: ${env}`,
    `Profile: ${config.profile ?? "none"}`,
    `Live orders: ${liveState}`,
    `Dry-run first: ${config.liveOrders.alwaysDryRunFirst ? "yes" : "no"}`,
    `Liquidity gates: minDayVolume=${config.liquidity.minDayVolume}, minOpenInterest=${config.liquidity.minOpenInterest}`,
    `Strategy clock: ${config.strategy.timezone}, allocationCutoff=${config.strategy.allocationCutoffTime}, liquidation=${config.strategy.liquidationTime}`,
    `Config path: ${runtimeState.configPath}`,
    "=======================================================",
  ].join("\n");
}
