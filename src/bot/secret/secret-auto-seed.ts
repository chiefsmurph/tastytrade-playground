import seedSymbol from "../seed-symbol";
import { SECRET_AUTO_SEED_ORDER_SOURCE } from "../order-sources";
import { SecretSourcePosition, SecretTickerRecPick } from "./types";

const lastAutoSeedAtBySymbol = new Map<string, number>();

const DEFAULT_AUTO_SEED_START_MINUTE = 6 * 60 + 30;
const DEFAULT_AUTO_SEED_END_MINUTE = 12 * 60 + 15;

export function shouldAutoSeedOnSecretPositionsUpdate(): boolean {
  const raw = process.env.SECRET_AUTO_SEED_ON_POSITIONS_UPDATE
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function shouldAutoSeedOnTickerRecsUpdate(): boolean {
  const raw = process.env.SECRET_AUTO_SEED_ON_TICKER_RECS_UPDATE
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isAnySecretAutoSeedEnabled(): boolean {
  return (
    shouldAutoSeedOnSecretPositionsUpdate() ||
    shouldAutoSeedOnTickerRecsUpdate()
  );
}

function parseMinuteOfDay(value: string | undefined): number | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(?:[01]?\d|2[0-3]):[0-5]\d$/);
  if (!match) {
    return null;
  }

  const [hoursText, minutesText] = trimmed.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

function getAutoSeedWindowStartMinute(): number {
  return (
    parseMinuteOfDay(process.env.SECRET_AUTO_SEED_START_TIME) ??
    DEFAULT_AUTO_SEED_START_MINUTE
  );
}

function getAutoSeedWindowEndMinute(): number {
  return (
    parseMinuteOfDay(process.env.SECRET_AUTO_SEED_END_TIME) ??
    DEFAULT_AUTO_SEED_END_MINUTE
  );
}

function isWithinAutoSeedWindow(currentTime: Date): boolean {
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const startMinute = getAutoSeedWindowStartMinute();
  const endMinute = getAutoSeedWindowEndMinute();

  return minuteOfDay >= startMinute && minuteOfDay <= endMinute;
}

function getAutoSeedCooldownMs(): number {
  const raw = process.env.SECRET_AUTO_SEED_COOLDOWN_MS?.trim();
  if (!raw) {
    return 10 * 60 * 1000;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 10 * 60 * 1000;
  }

  return parsed;
}

function normalizeSideForSeed(
  position: SecretSourcePosition,
): "call" | "put" | null {
  const raw = String(position.side ?? "").trim().toLowerCase();
  if (raw === "call" || raw === "c") {
    return "call";
  }
  if (raw === "put" || raw === "p") {
    return "put";
  }

  return null;
}

function hasQualityToBuy(position: SecretSourcePosition): boolean {
  const raw = position.qualityToBuy;

  if (typeof raw === "boolean") {
    return raw;
  }

  if (typeof raw === "number") {
    return raw === 1;
  }

  const normalized = String(raw ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function toBooleanFlag(raw: unknown): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }

  if (typeof raw === "number") {
    return raw === 1;
  }

  const normalized = String(raw ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

async function maybeAutoSeedSymbol(options: {
  symbol: string;
  side: "call" | "put";
  scope: string;
}): Promise<void> {
  const cooldownMs = getAutoSeedCooldownMs();
  const now = Date.now();
  const lastSeedAt = lastAutoSeedAtBySymbol.get(options.symbol) ?? 0;
  if (now - lastSeedAt < cooldownMs) {
    return;
  }

  try {
    const result = await seedSymbol(options.symbol, options.side, undefined, {
      orderSource: SECRET_AUTO_SEED_ORDER_SOURCE,
      priceMode: "mid",
    });
    lastAutoSeedAtBySymbol.set(options.symbol, now);
    console.log(
      JSON.stringify(
        {
          scope: options.scope,
          symbol: options.symbol,
          side: options.side,
          result,
          timestamp: new Date(now).toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${options.scope}] failed for ${options.symbol}: ${message}`);
  }
}

export async function maybeAutoSeedFromSecretPositions(
  sourcePositions: SecretSourcePosition[],
): Promise<void> {
  if (!shouldAutoSeedOnSecretPositionsUpdate()) {
    return;
  }

  if (!isWithinAutoSeedWindow(new Date())) {
    return;
  }

  for (const position of sourcePositions) {
    const symbol = String(position.ticker ?? "").trim().toUpperCase();
    if (!symbol) {
      continue;
    }

    if (!hasQualityToBuy(position)) {
      continue;
    }

    const side = normalizeSideForSeed(position) ?? "call";
    await maybeAutoSeedSymbol({
      symbol,
      side,
      scope: "secret-auto-seed",
    });
  }
}

export async function maybeAutoSeedFromTickerRecs(
  picks: SecretTickerRecPick[],
): Promise<void> {
  if (!shouldAutoSeedOnTickerRecsUpdate()) {
    return;
  }

  if (!isWithinAutoSeedWindow(new Date())) {
    return;
  }

  for (const pick of picks) {
    const symbol = String(pick.ticker ?? "").trim().toUpperCase();
    if (!symbol) {
      continue;
    }

    if (!toBooleanFlag(pick.shouldBuy)) {
      continue;
    }

    await maybeAutoSeedSymbol({
      symbol,
      side: "call",
      scope: "secret-auto-seed-ticker-recs",
    });
  }
}
