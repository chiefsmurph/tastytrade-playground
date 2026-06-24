import { promises as fs } from "node:fs";
import path from "node:path";

export interface RunPlanRow {
  estimatedCost: number;
  limitPrice: number;
  quantity: number;
  route: string;
  symbol: string;
  underlyingSymbol: string;
}

export interface RunPlanSelectedGroup {
  askWeight: number;
  bidWeight: number;
  currentReturnPct: number;
  groupKey: string;
  midWeight: number;
  rank: number;
  secretBuyWeight: number | null;
  strategyAction?: "MANAGE_ALLOCATION" | "CLOSE_POSITION";
  targetAccountExposure: number;
  targetDTE: number;
  underlyingSymbol: string;
}

export interface RunGroupReturn {
  askReturnPct: number;
  bidReturnPct: number;
  currentReturnPct: number;
  side: "call" | "put" | "none";
  buyWeight: number | null;
  daytradeScore: number | null;
  returnPerc: number | null;
  superRecScore: number | null;
  totalCostBasis: number;
  totalUnrealizedReturnAsk: number;
  totalUnrealizedReturnBid: number;
  underlyingSymbol: string;
}

export interface RunStrategyDecision {
  currentReturnPct: number;
  strategyAction: "MANAGE_ALLOCATION" | "CLOSE_POSITION";
  reason: string;
  underlyingSymbol: string;
}

export interface RunCloseOrderFill {
  fillId: string | null;
  fillPrice: number | null;
  filledAt: string | null;
  quantity: number | null;
}

export interface RunCloseOrder {
  orderId: string | null;
  placedOrder: boolean;
  price: number | null;
  skippedReason: string | null;
  status: string | null;
  symbol: string;
  underlyingSymbol: string;
  fills: RunCloseOrderFill[];
}

export interface RunHistoryEntry {
  accountNumber: string;
  closeOrders: RunCloseOrder[];
  executionSummary: {
    allocationEstimatedTotal: number;
    allocationPlacedCount: number;
    allocationSkippedCount: number;
    cancelledOrderCount: number;
    closeOrderCount: number;
  };
  id: string;
  groups: RunGroupReturn[];
  plan: {
    diagnostics?: {
      currentReturnPct: number;
      groupKey?: string;
      skippedReason: string;
      strategyAction: "MANAGE_ALLOCATION" | "CLOSE_POSITION";
      underlyingSymbol: string;
    }[];
    ignoredGroups?: RunPlanSelectedGroup[];
    rows: RunPlanRow[];
    selectedGroups?: RunPlanSelectedGroup[];
    unselectedGroups?: RunPlanSelectedGroup[];
    totalContracts: number;
    totalEstimatedCost: number;
  };
  strategyDecisions: RunStrategyDecision[];
  snapshot: {
    dynamicTakeProfitTarget: number;
    currentExposurePct: number;
    currentExposureValue: number;
    secondsSinceLastPositionsUpdate: number | null;
    routeWeights: {
      ask: number;
      bid: number;
      mid: number;
    };
    targetDTE: number;
    targetExposurePct: number;
    targetExposureValue: number;
    totalCapital: number;
  };
  timestamp: string;
}

interface AppendRunHistoryInput {
  accountNumber: string;
  closeOrders: RunHistoryEntry["closeOrders"];
  executionSummary: RunHistoryEntry["executionSummary"];
  groups: RunHistoryEntry["groups"];
  plan: RunHistoryEntry["plan"];
  strategyDecisions: RunHistoryEntry["strategyDecisions"];
  snapshot: RunHistoryEntry["snapshot"];
}

function sanitizeAccountNumberForPath(accountNumber: string): string {
  const normalized = String(accountNumber ?? "").trim();
  if (!normalized) {
    return "unknown-account";
  }

  return normalized.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getRunHistoryDirectory(): string {
  const configuredDirectory = process.env.TASTYTRADE_BOT_RUN_HISTORY_DIR?.trim();
  if (configuredDirectory) {
    return configuredDirectory;
  }

  return path.join(process.cwd(), "data", "runs");
}

function getRunHistoryPathForAccount(accountNumber: string): string {
  const safeAccountNumber = sanitizeAccountNumberForPath(accountNumber);
  return path.join(getRunHistoryDirectory(), `${safeAccountNumber}.ndjson`);
}

async function readRunHistoryFile(historyPath: string): Promise<RunHistoryEntry[]> {
  let raw = "";

  try {
    raw = await fs.readFile(historyPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed: RunHistoryEntry[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      parsed.push(JSON.parse(lines[index]) as RunHistoryEntry);
    } catch {
      // Skip malformed lines to keep history readable even after partial writes.
    }
  }

  return parsed;
}

export async function appendRunHistory(
  input: AppendRunHistoryInput,
): Promise<RunHistoryEntry> {
  const entry: RunHistoryEntry = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
  };

  const historyPath = getRunHistoryPathForAccount(input.accountNumber);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${JSON.stringify(entry)}\n`, "utf8");

  return entry;
}

export async function getRecentRunHistory(
  limit = 20,
  accountNumber?: string,
): Promise<RunHistoryEntry[]> {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 20;

  if (accountNumber?.trim()) {
    const accountEntries = await readRunHistoryFile(
      getRunHistoryPathForAccount(accountNumber),
    );
    return accountEntries.slice(0, normalizedLimit);
  }

  const directoryPath = getRunHistoryDirectory();
  let fileNames: string[] = [];
  try {
    fileNames = await fs.readdir(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const ndjsonFiles = fileNames.filter((fileName) => fileName.endsWith(".ndjson"));
  const entriesByFile = await Promise.all(
    ndjsonFiles.map((fileName) =>
      readRunHistoryFile(path.join(directoryPath, fileName)),
    ),
  );

  const merged = entriesByFile
    .flat()
    .sort((left, right) =>
      String(right.timestamp).localeCompare(String(left.timestamp)),
    );

  return merged.slice(0, normalizedLimit);
}
