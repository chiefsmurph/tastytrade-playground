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

export interface RunGroupReturn {
  askReturnPct: number;
  bidReturnPct: number;
  currentReturnPct: number;
  totalCostBasis: number;
  totalUnrealizedReturnAsk: number;
  totalUnrealizedReturnBid: number;
  underlyingSymbol: string;
}

export interface RunHistoryEntry {
  accountNumber: string;
  executionSummary: {
    allocationEstimatedTotal: number;
    allocationFailedCount?: number;
    allocationPlacedCount: number;
    allocationSkippedCount: number;
    cancelledOrderCount: number;
    closePlacedCount?: number;
    closeOrderCount: number;
    closeSkippedCount?: number;
    skippedEvaluationCount?: number;
  };
  executionError?: string;
  id: string;
  groups: RunGroupReturn[];
  plan: {
    rows: RunPlanRow[];
    totalContracts: number;
    totalEstimatedCost: number;
  };
  snapshot: {
    dynamicTakeProfitTarget: number;
    currentExposurePct: number;
    currentExposureValue: number;
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
  executionError?: string;
  executionSummary: RunHistoryEntry["executionSummary"];
  groups: RunHistoryEntry["groups"];
  plan: RunHistoryEntry["plan"];
  snapshot: RunHistoryEntry["snapshot"];
}

function getRunHistoryPath(): string {
  return (
    process.env.TASTYTRADE_BOT_RUN_HISTORY_PATH ||
    path.join(process.cwd(), "data", "runs.ndjson")
  );
}

export async function appendRunHistory(
  input: AppendRunHistoryInput,
): Promise<RunHistoryEntry> {
  const entry: RunHistoryEntry = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
  };

  const historyPath = getRunHistoryPath();
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${JSON.stringify(entry)}\n`, "utf8");
  await pruneRunHistory(historyPath);

  return entry;
}

async function pruneRunHistory(historyPath: string): Promise<void> {
  const maxEntries = Number(process.env.TASTYTRADE_BOT_RUN_HISTORY_MAX_ENTRIES ?? 1000);
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    return;
  }

  const raw = await fs.readFile(historyPath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length <= maxEntries) {
    return;
  }

  await fs.writeFile(
    historyPath,
    `${lines.slice(-Math.floor(maxEntries)).join("\n")}\n`,
    "utf8",
  );
}

export async function getRecentRunHistory(limit = 20): Promise<RunHistoryEntry[]> {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 20;

  const historyPath = getRunHistoryPath();
  let raw = "";

  try {
    const handle = await fs.open(historyPath, "r");
    try {
      const stat = await handle.stat();
      const maxBytes = 1024 * 1024;
      const readLength = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(readLength);
      await handle.read(buffer, 0, readLength, Math.max(0, stat.size - readLength));
      raw = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
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
  for (let index = lines.length - 1; index >= 0 && parsed.length < normalizedLimit; index -= 1) {
    try {
      parsed.push(JSON.parse(lines[index]) as RunHistoryEntry);
    } catch {
      // Skip malformed lines to keep history readable even after partial writes.
    }
  }

  return parsed;
}
