import { PositionEvaluationExecutionResult } from "./execute-position-evaluations";
import { PositionGroupEvaluation } from "./evaluate-position";

export interface LastBotRunState {
  accountNumber?: string;
  completedEvaluations: PositionGroupEvaluation[];
  executionResults: PositionEvaluationExecutionResult | null;
  updatedAt: string | null;
}

const lastBotRunStateByAccount = new Map<string, LastBotRunState>();

export function getLastBotRunState(accountNumber?: string): LastBotRunState | Record<string, LastBotRunState> {
  if (!accountNumber) {
    return Object.fromEntries(lastBotRunStateByAccount.entries());
  }

  const existing = lastBotRunStateByAccount.get(accountNumber);

  if (!existing) {
    return {
      accountNumber,
      completedEvaluations: [],
      executionResults: null,
      updatedAt: null,
    };
  }

  return {
    accountNumber: existing.accountNumber,
    completedEvaluations: existing.completedEvaluations,
    executionResults: existing.executionResults,
    updatedAt: existing.updatedAt,
  };
}

export function setLastBotRunState(
  accountNumber: string,
  completedEvaluations: PositionGroupEvaluation[],
  executionResults: PositionEvaluationExecutionResult,
) {
  lastBotRunStateByAccount.set(accountNumber, {
    accountNumber,
    completedEvaluations,
    executionResults,
    updatedAt: new Date().toISOString(),
  });
}