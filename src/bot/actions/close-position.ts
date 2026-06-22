import { PositionGroupEvaluation } from "../evaluate-position";
import { ExecutionTargets, ProgrammaticAction } from "../evaluate-trading-strategy";
import { buildClosingOrderPayload } from "./order-utils";
import { placeOrderSafely, SafeOrderResult } from "./place-order";

export interface ClosePositionResult {
  accountNumber: string;
  action: Extract<ProgrammaticAction, "CLOSE_POSITION" | "LIQUIDATE_POSITION">;
  orderResponse?: unknown;
  placedOrder: boolean;
  safeOrderResult?: SafeOrderResult;
  skippedReason?: string;
  symbol: string;
  underlyingSymbol: string;
}

export async function closePosition(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
  targets: ExecutionTargets,
) {
  const results: ClosePositionResult[] = [];

  for (const snapshot of evaluation.positionSnapshots) {
    const action =
      evaluation.strategy.action === "LIQUIDATE_POSITION"
        ? "LIQUIDATE_POSITION"
        : "CLOSE_POSITION";
    const order = buildClosingOrderPayload(snapshot, targets, {
      liquidation: action === "LIQUIDATE_POSITION",
    });
    if (!order) {
      results.push({
        accountNumber,
        action,
        placedOrder: false,
        skippedReason: "missing price or quantity",
        symbol: snapshot.orderSymbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    const safeOrderResult = await placeOrderSafely(accountNumber, order);

    results.push({
      accountNumber,
      action,
      orderResponse: safeOrderResult.orderResponse,
      placedOrder: safeOrderResult.submitted,
      safeOrderResult,
      skippedReason: safeOrderResult.skippedReason,
      symbol: snapshot.orderSymbol,
      underlyingSymbol: evaluation.underlyingSymbol,
    });
  }

  return results;
}

export default closePosition;
