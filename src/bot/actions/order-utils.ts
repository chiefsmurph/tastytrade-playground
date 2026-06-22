import { getBotConfig } from "../../core/bot-config";
import { CurrentPosition } from "../../core/types";
import { PositionQuoteSnapshot } from "../evaluate-position";
import { ExecutionTargets } from "../evaluate-trading-strategy";

const DEFAULT_OPTION_TICK_SIZE = 0.01;

export interface OrderLeg {
  action: string;
  symbol: string;
  quantity: number;
  "instrument-type": string;
}

export interface OrderPayload {
  "advanced-instructions"?: {
    "strict-position-effect-validation": boolean;
  };
  legs: OrderLeg[];
  "order-type": "Limit" | "Market";
  price?: string;
  "price-effect"?: "Credit" | "Debit";
  source: string;
  "time-in-force": "Day" | "GTC";
}

export function getPositionQuantity(position: CurrentPosition): number {
  return Math.abs(Number(position.quantity) || 0);
}

export function isShortPosition(position: CurrentPosition): boolean {
  const quantityDirection = String(
    position.quantityDirection ?? position.quantity_direction ?? "",
  ).toLowerCase();
  if (quantityDirection === "short") {
    return true;
  }
  if (quantityDirection === "long") {
    return false;
  }

  return String(position.costEffect ?? position.cost_effect ?? "").toLowerCase() === "credit";
}

export function getClosingAction(position: CurrentPosition): string {
  return isShortPosition(position) ? "Buy to Close" : "Sell to Close";
}

export function normalizeInstrumentType(instrumentType: string | undefined): string {
  switch ((instrumentType ?? "").trim().toLowerCase()) {
    case "equity":
      return "Equity";
    case "option":
    case "equity option":
      return "Equity Option";
    case "future":
      return "Future";
    case "future option":
      return "Future Option";
    case "cryptocurrency":
    case "crypto":
      return "Cryptocurrency";
    default:
      return instrumentType || "Equity Option";
  }
}

export function getWeightedOrderPrice(
  bid: number,
  ask: number,
  targets: Pick<ExecutionTargets, "bidWeight" | "midWeight" | "askWeight">,
): number {
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask || bid;
  const totalWeight = targets.bidWeight + targets.midWeight + targets.askWeight;

  if (totalWeight <= 0) {
    return midpoint;
  }

  return (
    bid * targets.bidWeight +
    midpoint * targets.midWeight +
    ask * targets.askWeight
  ) / totalWeight;
}

export function roundOrderPrice(price: number): string {
  return (Math.round(price * 100) / 100).toFixed(2);
}

function getLiquidationPrice(snapshot: PositionQuoteSnapshot): number | null {
  const slippage = getBotConfig().liquidation.slippageTicks * DEFAULT_OPTION_TICK_SIZE;
  if (isShortPosition(snapshot.position)) {
    const ask = snapshot.currentAskPrice || snapshot.currentBidPrice;
    return ask > 0 ? ask + slippage : null;
  }

  const bid = snapshot.currentBidPrice || snapshot.currentAskPrice;
  return bid > 0 ? Math.max(DEFAULT_OPTION_TICK_SIZE, bid - slippage) : null;
}

export function buildClosingOrderPayload(
  snapshot: PositionQuoteSnapshot,
  targets: Pick<ExecutionTargets, "bidWeight" | "midWeight" | "askWeight">,
  options: { liquidation?: boolean } = {},
): OrderPayload | null {
  const quantity = getPositionQuantity(snapshot.position);
  if (quantity <= 0) {
    return null;
  }

  const price =
    options.liquidation && getBotConfig().liquidation.mode === "marketableLimit"
      ? getLiquidationPrice(snapshot)
      : getWeightedOrderPrice(
          snapshot.currentBidPrice,
          snapshot.currentAskPrice,
          targets,
        );

  if (!(price && price > 0)) {
    return null;
  }

  const action = getClosingAction(snapshot.position);

  return {
    source: "tastytrade-playground",
    "time-in-force": "Day",
    "order-type": "Limit",
    price: roundOrderPrice(price),
    "price-effect": action.startsWith("Buy") ? "Debit" : "Credit",
    "advanced-instructions": {
      "strict-position-effect-validation": true,
    },
    legs: [
      {
        action,
        symbol: snapshot.orderSymbol,
        quantity,
        "instrument-type": normalizeInstrumentType(
          snapshot.position.instrumentType ?? snapshot.position.instrument_type,
        ),
      },
    ],
  };
}

export function getGroupMarketValue(positionSnapshots: PositionQuoteSnapshot[]): number {
  return positionSnapshots.reduce(
    (sum, snapshot) => {
      const price =
        snapshot.positionDirection === "short"
          ? snapshot.currentAskPrice
          : snapshot.currentBidPrice;
      return sum + Math.max(0, price) * snapshot.quantityWeight;
    },
    0,
  );
}

export function inferOptionSide(symbol: string): "call" | "put" | null {
  const trimmed = symbol.trim();
  const match = trimmed.match(/([CP])(\d+)$/i);
  if (!match) {
    return null;
  }

  return match[1].toUpperCase() === "P" ? "put" : "call";
}
