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

export function getLastBotRunState(): LastBotRunState {
  return {
    accountNumber: lastBotRunState.accountNumber,
    completedEvaluations: lastBotRunState.completedEvaluations,
    executionResults: lastBotRunState.executionResults,
    updatedAt: lastBotRunState.updatedAt,
  };
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
}