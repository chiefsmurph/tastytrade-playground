import { AccountBalance, CurrentPosition } from "./types";

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toCamelKey(key: string): string {
  return key.replace(/[-_]+([a-zA-Z0-9])/g, (_, part: string) =>
    part.toUpperCase(),
  );
}

export function normalizeBrokerKeys<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeBrokerKeys(item)) as T;
  }

  if (!isRecord(value)) {
    return value as T;
  }

  const normalized: RawRecord = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    normalized[toCamelKey(key)] = normalizeBrokerKeys(nestedValue);
  }

  return normalized as T;
}

export function readBrokerField(
  value: unknown,
  keys: string[],
): unknown {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized = normalizeBrokerKeys<RawRecord>(value);
  for (const key of keys) {
    const rawValue = value[key] ?? normalized[toCamelKey(key)] ?? normalized[key];
    if (rawValue != null && rawValue !== "") {
      return rawValue;
    }
  }

  return undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBooleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function readString(record: unknown, keys: string[]): string | undefined {
  return toStringOrUndefined(readBrokerField(record, keys));
}

function readNumber(record: unknown, keys: string[]): number | null {
  return toNumberOrNull(readBrokerField(record, keys));
}

function readBoolean(record: unknown, keys: string[]): boolean | undefined {
  return toBooleanOrUndefined(readBrokerField(record, keys));
}

export function normalizeAccountBalance(rawBalance: unknown): AccountBalance {
  const normalized = normalizeBrokerKeys<AccountBalance>(rawBalance);
  return {
    ...(isRecord(rawBalance) ? rawBalance : {}),
    ...normalized,
    accountNumber: readString(rawBalance, ["account-number", "account_number", "accountNumber"]),
    derivativeBuyingPower: readNumber(rawBalance, [
      "derivative-buying-power",
      "derivative_buying_power",
      "derivativeBuyingPower",
    ]) ?? undefined,
    netLiquidatingValue: readNumber(rawBalance, [
      "net-liquidating-value",
      "net_liquidating_value",
      "netLiquidatingValue",
    ]) ?? undefined,
    pendingCash: readNumber(rawBalance, [
      "pending-cash",
      "pending_cash",
      "pendingCash",
    ]) ?? undefined,
    pendingCashEffect: readString(rawBalance, [
      "pending-cash-effect",
      "pending_cash_effect",
      "pendingCashEffect",
    ]),
  };
}

export function normalizeAccountBalances(rawBalances: unknown[]): AccountBalance[] {
  return rawBalances.map((balance) => normalizeAccountBalance(balance));
}

export function normalizePosition(rawPosition: unknown): CurrentPosition {
  const normalized = normalizeBrokerKeys<RawRecord>(rawPosition);
  const symbol = readString(rawPosition, ["symbol"]) ?? "";
  const orderSymbol = readString(rawPosition, ["order-symbol", "order_symbol", "orderSymbol"]) ?? symbol;
  const streamerSymbol = readString(rawPosition, [
    "streamer-symbol",
    "streamer_symbol",
    "streamerSymbol",
  ]);
  const quantity = readNumber(rawPosition, ["quantity"]) ?? 0;
  const instrumentType = readString(rawPosition, [
    "instrument-type",
    "instrument_type",
    "instrumentType",
  ]);
  const underlyingSymbol = readString(rawPosition, [
    "underlying-symbol",
    "underlying_symbol",
    "underlyingSymbol",
  ]);
  const quantityDirection = readString(rawPosition, [
    "quantity-direction",
    "quantity_direction",
    "quantityDirection",
  ]);
  const averageOpenPrice = readNumber(rawPosition, [
    "average-open-price",
    "average_open_price",
    "averageOpenPrice",
  ]);
  const markPrice = readNumber(rawPosition, [
    "mark-price",
    "mark_price",
    "markPrice",
    "mark",
  ]);
  const closePrice = readNumber(rawPosition, [
    "close-price",
    "close_price",
    "closePrice",
  ]);
  const costEffect = readString(rawPosition, [
    "cost-effect",
    "cost_effect",
    "costEffect",
  ]);
  const multiplier = readNumber(rawPosition, ["multiplier"]);
  const createdAt = readString(rawPosition, ["created-at", "created_at", "createdAt"]);
  const updatedAt = readString(rawPosition, ["updated-at", "updated_at", "updatedAt"]);
  const averageDailyMarketClosePrice = readNumber(rawPosition, [
    "average-daily-market-close-price",
    "average_daily_market_close_price",
    "averageDailyMarketClosePrice",
  ]);

  const errors: string[] = [];
  if (!symbol) errors.push("missing symbol");
  if (!instrumentType) errors.push("missing instrument type");
  if (!Number.isFinite(quantity)) errors.push("missing quantity");
  if (!quantityDirection) errors.push("missing quantity direction");
  if (averageOpenPrice == null) errors.push("missing average open price");
  if (multiplier == null || multiplier <= 0) errors.push("missing or invalid multiplier");

  return {
    ...normalized,
    accountNumber: readString(rawPosition, [
      "account-number",
      "account_number",
      "accountNumber",
    ]),
    account_number: readString(rawPosition, [
      "account-number",
      "account_number",
      "accountNumber",
    ]),
    symbol: orderSymbol,
    orderSymbol,
    quoteSymbol: streamerSymbol ?? symbol,
    streamerSymbol,
    instrumentType,
    instrument_type: instrumentType,
    underlyingSymbol,
    underlying_symbol: underlyingSymbol,
    quantity,
    quantityDirection,
    quantity_direction: quantityDirection,
    averageOpenPrice,
    average_open_price: averageOpenPrice,
    markPrice,
    mark_price: markPrice,
    closePrice,
    close_price: closePrice,
    costEffect,
    cost_effect: costEffect,
    multiplier,
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
    isSuppressed: readBoolean(rawPosition, ["is-suppressed", "is_suppressed", "isSuppressed"]),
    isFrozen: readBoolean(rawPosition, ["is-frozen", "is_frozen", "isFrozen"]),
    restrictedQuantity: readNumber(rawPosition, [
      "restricted-quantity",
      "restricted_quantity",
      "restrictedQuantity",
    ]),
    averageDailyMarketClosePrice,
    average_daily_market_close_price: averageDailyMarketClosePrice,
    normalizationErrors: errors,
  };
}

export function normalizePositions(rawPositions: unknown[]): CurrentPosition[] {
  return rawPositions.map((position) => normalizePosition(position));
}
