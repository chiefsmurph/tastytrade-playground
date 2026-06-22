import { promises as fs } from "node:fs";
import path from "node:path";
import { PositionEvaluationExecutionResult } from "./execute-position-evaluations";
import { PositionGroupEvaluation } from "./evaluate-position";

export interface LastBotRunState {
  accountNumber?: string;
  completedEvaluations: PositionGroupEvaluation[];
  executionResults: PositionEvaluationExecutionResult | null;
  updatedAt: string | null;
}

const lastBotRunState: LastBotRunState = {
  completedEvaluations: [],
  executionResults: null,
  updatedAt: null,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getLastRunStatePath(): string {
  return (
    process.env.TASTYTRADE_BOT_LAST_RUN_STATE_PATH ||
    path.join(process.cwd(), "data", "last-run-state.json")
  );
}

export function getLastBotRunState(): LastBotRunState {
  return clone(lastBotRunState);
}

export async function loadLastBotRunState(): Promise<LastBotRunState> {
  const statePath = getLastRunStatePath();
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as LastBotRunState;
    lastBotRunState.accountNumber = parsed.accountNumber;
    lastBotRunState.completedEvaluations = parsed.completedEvaluations ?? [];
    lastBotRunState.executionResults = parsed.executionResults ?? null;
    lastBotRunState.updatedAt = parsed.updatedAt ?? null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Could not load last run state: ${message}`);
    }
  }

  return getLastBotRunState();
}

export function setLastBotRunState(
  accountNumber: string,
  completedEvaluations: PositionGroupEvaluation[],
  executionResults: PositionEvaluationExecutionResult,
) {
  lastBotRunState.accountNumber = accountNumber;
  lastBotRunState.completedEvaluations = completedEvaluations;
  lastBotRunState.executionResults = executionResults;
  lastBotRunState.updatedAt = new Date().toISOString();

  void persistLastBotRunState();
}

async function persistLastBotRunState(): Promise<void> {
  const statePath = getLastRunStatePath();
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(lastBotRunState, null, 2), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not persist last run state: ${message}`);
  }
}
