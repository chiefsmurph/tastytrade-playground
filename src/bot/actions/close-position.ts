import tastytradeApi from "../../core/tastytrade-client";
import { PositionGroupEvaluation } from "../evaluate-position";
import { buildClosingOrderPayload } from "./order-utils";

export interface ClosePositionResult {
  accountNumber: string;
  action: "CLOSE_POSITION";
  orderResponse?: unknown;
  placedOrder: boolean;
  skippedReason?: string;
  symbol: string;
  underlyingSymbol: string;
}

export async function closePosition(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
) {
  const results: ClosePositionResult[] = [];

  for (const snapshot of evaluation.positionSnapshots) {
    const order = buildClosingOrderPayload(snapshot, evaluation.strategy);
    if (!order) {
      results.push({
        accountNumber,
        action: "CLOSE_POSITION",
        placedOrder: false,
        skippedReason: "missing price or quantity",
        symbol: snapshot.position.symbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    const orderResponse = await tastytradeApi.orderService.createOrder(
      accountNumber,
      order,
    );

    results.push({
      accountNumber,
      action: "CLOSE_POSITION",
      orderResponse,
      placedOrder: true,
      symbol: snapshot.position.symbol,
      underlyingSymbol: evaluation.underlyingSymbol,
    });
  }

  return results;
}

export default closePosition;
