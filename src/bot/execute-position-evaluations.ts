import {
  getConservativeSpendableFunds,
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
} from "~/core/account-balance";
import tastytradeApi from "~/core/tastytrade-client";
import { TastytradeAccountBalance, TastytradeOrder } from "~/core/types";
import { PositionGroupEvaluation } from "./evaluate-position";
import {
  ExecutionTargets,
  getTimeOfDayExecutionTargets,
} from "./evaluate-trading-strategy";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import {
  selectManageEvaluationsByBuyingPower,
} from "./group-allocation-priority";
import {
  AllocationExecutionResult,
  buildInitialBudget,
  getUpdatedBudgetAfterAllocation,
  manageAllocationForGroup,
} from "./actions/manage-allocation";
import { getDefaultAccountNumber } from "../ipc-server";

export interface CancelOrderResult {
  cancelled: boolean;
  orderId: number;
  response?: TastytradeOrder;
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
  const liveOrders = await tastytradeApi.orderService.getLiveOrders(
    resolvedAccountNumber,
  );

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

    const response = await tastytradeApi.orderService.cancelOrder(
      resolvedAccountNumber,
      orderId,
    );
    results.push({
      cancelled: true,
      orderId,
      response,
    });
  }

  return results;
}

export async function executePositionEvaluations(
  accountNumber: string,
  accountBalance: TastytradeAccountBalance,
  evaluations: PositionGroupEvaluation[],
  runExecutionTargets?: ExecutionTargets,
): Promise<PositionEvaluationExecutionResult> {
  const cancelledOrders = await cancelAllLiveOrders(accountNumber);

  const sharedExecutionTargets =
    runExecutionTargets ??
    getTimeOfDayExecutionTargets(evaluations[0]?.metrics.currentTime ?? new Date());

  const evaluationsWithTargets = evaluations.map((evaluation) => ({
    ...evaluation,
    executionTargets: sharedExecutionTargets,
  }));

  const closeEvaluations = evaluationsWithTargets.filter(
    (evaluation) => evaluation.strategy.action === "CLOSE_POSITION",
  );
  const manageEvaluations = selectManageEvaluationsByBuyingPower(
    evaluationsWithTargets.filter(
      (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
    ),
    getConservativeSpendableFunds(accountBalance),
  ).sort((a, b) => {
    const aExposure = a.executionTargets?.targetAccountExposure ?? 0;
    const bExposure = b.executionTargets?.targetAccountExposure ?? 0;

    if (bExposure !== aExposure) {
      return bExposure - aExposure;
    }
    return a.currentReturn - b.currentReturn;
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
    getConservativeSpendableFunds(accountBalance),
    getEffectiveTotalCapital(accountBalance),
    evaluationsWithTargets,
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
    evaluations: evaluationsWithTargets,
  };
}

export default executePositionEvaluations;