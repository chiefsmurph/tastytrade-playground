import {
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
} from "../core/account-balance";
import { getBotConfig } from "../core/bot-config";
import tastytradeApi from "../core/tastytrade-client";
import { AccountBalance } from "../core/types";
import { PositionGroupEvaluation } from "./evaluate-position";
import {
  ExecutionTargets,
  getTimeOfDayExecutionTargets,
} from "./evaluate-trading-strategy";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import {
  AllocationExecutionResult,
  buildInitialBudget,
  getUpdatedBudgetAfterAllocation,
  manageAllocationForGroup,
} from "./actions/manage-allocation";
import { getDefaultAccountNumber } from "../ipc-server";
import { getGroupMarketValue } from "./actions/order-utils";

interface LiveOrder {
  cancellable?: boolean;
  id: number | string;
  status?: string;
}

export interface CancelOrderResult {
  cancelled: boolean;
  orderId: number;
  error?: unknown;
  response?: unknown;
  skippedReason?: string;
}

export interface PositionEvaluationExecutionResult {
  allocationOrders: AllocationExecutionResult[];
  cancelledOrders: CancelOrderResult[];
  closeOrders: ClosePositionResult[];
  evaluations: PositionGroupEvaluation[];
}

function isTerminalOrderStatus(status: string | undefined): boolean {
  return ["Cancelled", "Canceled", "Filled", "Expired", "Rejected", "Removed", "Partially Removed"].includes(
    status ?? "",
  );
}

export async function cancelAllLiveOrders(
  accountNumber?: string,
): Promise<CancelOrderResult[]> {

  const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
  const liveOrders = (await tastytradeApi.orderService.getLiveOrders(
    resolvedAccountNumber,
  )) as LiveOrder[];

  const results: CancelOrderResult[] = [];
  for (const order of liveOrders) {
    const orderId = Number(order.id);
    if (!Number.isFinite(orderId)) {
      continue;
    }

    if (!order.cancellable || isTerminalOrderStatus(order.status)) {
      results.push({
        cancelled: false,
        orderId,
        skippedReason: "order is not cancellable",
      });
      continue;
    }

    try {
      const response = await tastytradeApi.orderService.cancelOrder(
        resolvedAccountNumber,
        orderId,
      );
      results.push({
        cancelled: true,
        orderId,
        response,
      });
    } catch (error) {
      results.push({
        cancelled: false,
        error:
          error instanceof Error
            ? ((error as Error & { response?: { data?: unknown } }).response?.data ?? error.message)
            : error,
        orderId,
        skippedReason: "cancel order failed",
      });
    }
  }

  return results;
}

export async function executePositionEvaluations(
  accountNumber: string,
  accountBalance: AccountBalance,
  evaluations: PositionGroupEvaluation[],
  runExecutionTargets?: ExecutionTargets,
  cancelledOrders: CancelOrderResult[] = [],
): Promise<PositionEvaluationExecutionResult> {
  const sharedExecutionTargets =
    runExecutionTargets ??
    getTimeOfDayExecutionTargets(evaluations[0]?.metrics.currentTime ?? new Date());

  const evaluationsWithTargets = evaluations.map((evaluation) => ({
    ...evaluation,
    executionTargets: sharedExecutionTargets,
  }));

  const closeEvaluations = evaluationsWithTargets.filter(
    (evaluation) =>
      evaluation.strategy.action === "CLOSE_POSITION" ||
      evaluation.strategy.action === "LIQUIDATE_POSITION",
  );
  const manageEvaluations = evaluationsWithTargets
    .filter(
      (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
    )
    .sort((a, b) => {
      if (getBotConfig().strategy.allocationPriority === "bestReturn") {
        return b.currentReturn - a.currentReturn;
      }

      const aExposure = getGroupMarketValue(a.positionSnapshots);
      const bExposure = getGroupMarketValue(b.positionSnapshots);
      if (aExposure !== bExposure) {
        return aExposure - bExposure;
      }

      return b.currentReturn - a.currentReturn;
    });

  const closeOrders = (
    await Promise.all(
      closeEvaluations.map((evaluation) =>
        closePosition(
          accountNumber,
          evaluation,
          evaluation.executionTargets ?? sharedExecutionTargets,
        ),
      ),
    )
  ).flat();

  let budget = buildInitialBudget(
    getAccountBalanceNumber(
      accountBalance,
      "derivative_buying_power",
      "derivative-buying-power",
    ),
    getEffectiveTotalCapital(accountBalance),
    evaluationsWithTargets.filter(
      (evaluation) =>
        evaluation.strategy.action !== "CLOSE_POSITION" &&
        evaluation.strategy.action !== "LIQUIDATE_POSITION",
    ),
  );
  const allocationOrders: AllocationExecutionResult[] = [];

  for (const [index, evaluation] of manageEvaluations.entries()) {
    const groupsRemainingForAllocation = manageEvaluations.length - index;
    const result = await manageAllocationForGroup(
      accountNumber,
      evaluation,
      budget,
      groupsRemainingForAllocation,
    );
    allocationOrders.push(result);
    budget = getUpdatedBudgetAfterAllocation(budget, evaluation, result);
  }

  return {
    allocationOrders,
    cancelledOrders,
    closeOrders,
    evaluations: [...evaluationsWithTargets],
  };
}

export default executePositionEvaluations;
