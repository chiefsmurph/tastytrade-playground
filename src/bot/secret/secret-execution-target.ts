import { io } from "socket.io-client";
import { ExecutionTargets } from "../evaluate-trading-strategy";
import { SecretDataUpdatePayload, SecretSourcePosition } from "./types";

const SECRET_SOCKET_EVENT = "server:data-update";

let secretSocket: ReturnType<typeof io> | null = null;
let cachedSourcePositions: SecretSourcePosition[] = [];
let hasConnectedSecretSocket = false;
let secretSocketIsConnected = false;
let lastSecretPositionsUpdateAt: Date | null = null;

function getSecretPositionsSourceKey(): string | null {
  const configured = process.env.SECRET_DATA_UPDATE_POSITIONS_KEY?.trim();
  return configured && configured.length > 0 ? configured : null;
}

function getSecretSocketTimeoutMs(): number | null {
  const raw = process.env.SECRET_SOCKET_TIMEOUT_MS?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function isSecretModuleConfigured(): boolean {
  const socketUrl = process.env.SECRET_SOCKET_URL?.trim();
  const sourceKey = getSecretPositionsSourceKey();
  const timeoutMs = getSecretSocketTimeoutMs();

  return Boolean(socketUrl) && Boolean(sourceKey) && timeoutMs != null;
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function normalizeBuyWeight(buyWeight: number): number {
  // Incoming scale is typically around 50..400.
  return clamp(buyWeight / 400, 0, 1);
}

function toSecretExecutionTargets(
  buyWeight: number,
  baseTargets: ExecutionTargets,
): ExecutionTargets {
  const normalizedBuyWeight = normalizeBuyWeight(buyWeight);

  const targetAccountExposure = roundToTwoDecimals(
    clamp(0.4 + normalizedBuyWeight * 0.55, 0, 1),
  );
  const askWeight = roundToTwoDecimals(clamp(0.2 + normalizedBuyWeight * 0.6, 0, 0.95));
  const midWeight = roundToTwoDecimals(clamp(0.55 - normalizedBuyWeight * 0.2, 0.05, 0.7));
  const bidWeight = roundToTwoDecimals(clamp(1 - askWeight - midWeight, 0, 0.75));

  const normalizedMid = roundToTwoDecimals(clamp(1 - askWeight - bidWeight, 0, 1));

  return {
    targetDTE: baseTargets.targetDTE,
    targetAccountExposure,
    askWeight,
    bidWeight,
    midWeight: normalizedMid,
  };
}

function getBuyWeightsFromPositions(
  sourcePositions: SecretSourcePosition[],
  symbols: string[],
): number[] {
  const normalizedSymbols = new Set(symbols.map(normalizeTicker));

  return sourcePositions
    .filter((position): position is SecretSourcePosition => {
      const ticker = typeof position.ticker === "string" ? position.ticker : "";
      const buyWeight = Number(position.buyWeight);
      return (
        normalizedSymbols.has(normalizeTicker(ticker)) &&
        Number.isFinite(buyWeight)
      );
    })
    .map((position) => Number(position.buyWeight));
}

function getBuyWeightForSymbol(
  sourcePositions: SecretSourcePosition[],
  symbol: string,
): number | null {
  const normalizedSymbol = normalizeTicker(symbol);
  const match = sourcePositions.find((position) => {
    const ticker = typeof position.ticker === "string" ? position.ticker : "";
    return normalizeTicker(ticker) === normalizedSymbol;
  });

  if (!match) {
    return null;
  }

  const buyWeight = Number(match.buyWeight);
  return Number.isFinite(buyWeight) ? buyWeight : null;
}

function updateCachedPositionsFromPayload(payload: SecretDataUpdatePayload): void {
  const sourceKey = getSecretPositionsSourceKey();
  if (!sourceKey) {
    return;
  }

  const sourcePositions = payload.positions?.[sourceKey];
  if (!Array.isArray(sourcePositions)) {
    return;
  }

  cachedSourcePositions = sourcePositions as SecretSourcePosition[];
  lastSecretPositionsUpdateAt = new Date();
}

export function startSecretSocketConnection(): void {
  if (hasConnectedSecretSocket) {
    return;
  }

  if (!isSecretModuleConfigured()) {
    return;
  }

  const socketUrl = process.env.SECRET_SOCKET_URL?.trim();
  const timeoutMs = getSecretSocketTimeoutMs();
  if (!socketUrl || timeoutMs == null) {
    return;
  }

  secretSocket = io(socketUrl, {
    reconnection: true,
    timeout: timeoutMs,
    transports: ["websocket"],
  });

  secretSocket.on(SECRET_SOCKET_EVENT, (payload: SecretDataUpdatePayload) => {
    updateCachedPositionsFromPayload(payload);
  });

  secretSocket.on("connect", () => {
    secretSocketIsConnected = true;
    console.log("[secret] socket connected");
  });

  secretSocket.on("disconnect", (reason) => {
    secretSocketIsConnected = false;
    console.warn(`[secret] socket disconnected: ${reason}`);
  });

  secretSocket.on("connect_error", (error) => {
    secretSocketIsConnected = false;
    console.warn("[secret] socket connect_error", error?.message ?? error);
  });

  secretSocket.on("error", (error) => {
    console.warn("[secret] socket error", error);
  });

  hasConnectedSecretSocket = true;
}

export async function getSecretExecutionTargetForRun(options: {
  baseTargets: ExecutionTargets;
  symbols: string[];
}): Promise<ExecutionTargets | null> {
  if (!isSecretModuleConfigured()) {
    return null;
  }

  startSecretSocketConnection();

  const buyWeights = getBuyWeightsFromPositions(
    cachedSourcePositions,
    options.symbols,
  );
  if (buyWeights.length === 0) {
    return null;
  }

  const averageBuyWeight =
    buyWeights.reduce((sum, value) => sum + value, 0) / buyWeights.length;

  return toSecretExecutionTargets(averageBuyWeight, options.baseTargets);
}

export function getSecretBuyWeightForSymbol(symbol: string): number | null {
  if (!isSecretModuleConfigured()) {
    return null;
  }

  startSecretSocketConnection();
  return getBuyWeightForSymbol(cachedSourcePositions, symbol);
}

export function getSecretExecutionTargetForSymbol(options: {
  baseTargets: ExecutionTargets;
  symbol: string;
}): ExecutionTargets | null {
  if (!isSecretModuleConfigured()) {
    return null;
  }

  startSecretSocketConnection();

  const buyWeight = getBuyWeightForSymbol(
    cachedSourcePositions,
    options.symbol,
  );
  if (buyWeight === null) {
    return null;
  }

  return toSecretExecutionTargets(buyWeight, options.baseTargets);
}

export function getCachedSecretSourcePositions(): SecretSourcePosition[] {
  if (!isSecretModuleConfigured()) {
    return [];
  }

  return [...cachedSourcePositions];
}

export interface SecretSocketStatus {
  cachedPositionsCount: number;
  connected: boolean;
  hasConnected: boolean;
  lastPositionsUpdateAt: string | null;
  millisecondsSinceLastPositionsUpdate: number | null;
  moduleEnabled: boolean;
  positionsSourceKey: string | null;
  socketTimeoutMs: number | null;
  socketUrlConfigured: boolean;
}

export function getSecretSocketStatus(): SecretSocketStatus {
  const now = Date.now();
  const socketUrlConfigured = Boolean(process.env.SECRET_SOCKET_URL?.trim());
  const positionsSourceKey = getSecretPositionsSourceKey();
  const socketTimeoutMs = getSecretSocketTimeoutMs();
  const moduleEnabled = isSecretModuleConfigured();

  return {
    cachedPositionsCount: moduleEnabled ? cachedSourcePositions.length : 0,
    connected: moduleEnabled ? secretSocketIsConnected : false,
    hasConnected: hasConnectedSecretSocket,
    lastPositionsUpdateAt:
      moduleEnabled ? lastSecretPositionsUpdateAt?.toISOString() ?? null : null,
    millisecondsSinceLastPositionsUpdate:
      moduleEnabled && lastSecretPositionsUpdateAt
      ? Math.max(0, now - lastSecretPositionsUpdateAt.getTime())
      : null,
    moduleEnabled,
    positionsSourceKey,
    socketTimeoutMs,
    socketUrlConfigured,
  };
}
