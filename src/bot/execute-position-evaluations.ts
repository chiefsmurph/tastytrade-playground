import {
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
} from "../core/account-balance";
import tastytradeApi from "../core/tastytrade-client";
import { AccountBalance } from "../core/types";
import { PositionGroupEvaluation } from "./evaluate-position";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import {
  AllocationExecutionResult,
  buildInitialBudget,
  getUpdatedBudgetAfterAllocation,
  manageAllocationForGroup,
} from "./actions/manage-allocation";
import { getDefaultAccountNumber } from "../ipc-server";

interface LiveOrder {
  cancellable?: boolean;
  id: number | string;
  status?: string;
}

export interface CancelOrderResult {
  cancelled: boolean;
  orderId: number;
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
  accountBalance: AccountBalance,
  evaluations: PositionGroupEvaluation[],
): Promise<PositionEvaluationExecutionResult> {
  const cancelledOrders = await cancelAllLiveOrders(accountNumber);

  const closeEvaluations = evaluations.filter(
    (evaluation) => evaluation.strategy.action === "CLOSE_POSITION",
  );
  const manageEvaluations = evaluations
    .filter(
      (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
    )
    .sort((a, b) => {
      if (b.strategy.targetAccountExposure !== a.strategy.targetAccountExposure) {
        return b.strategy.targetAccountExposure - a.strategy.targetAccountExposure;
      }
      return a.currentReturn - b.currentReturn;
    });

  const closeOrders = (
    await Promise.all(
      closeEvaluations.map((evaluation) => closePosition(accountNumber, evaluation)),
    )
  ).flat();

  let budget = buildInitialBudget(
    getAccountBalanceNumber(
      accountBalance,
      "derivative_buying_power",
      "derivative-buying-power",
    ),
    getEffectiveTotalCapital(accountBalance),
    evaluations,
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
    evaluations,
  };
}

export default executePositionEvaluations;