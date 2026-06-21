import { CurrentPosition } from "../../core/types";
import { PositionQuoteSnapshot } from "../evaluate-position";
import { ExecutionStrategy } from "../evaluate-trading-strategy";

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
  const quantityDirection = position.quantity_direction?.toLowerCase();
  if (quantityDirection === "short") {
    return true;
  }
  if (quantityDirection === "long") {
    return false;
  }

  return position.cost_effect?.toLowerCase() === "credit";
}

export function getClosingAction(position: CurrentPosition): string {
  return isShortPosition(position) ? "Buy to Close" : "Sell to Close";
}

export function normalizeInstrumentType(instrumentType: string): string {
  switch (instrumentType.trim().toLowerCase()) {
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
      return instrumentType;
  }
}

export function getWeightedOrderPrice(
  bid: number,
  ask: number,
  strategy: Pick<ExecutionStrategy, "bidWeight" | "midWeight" | "askWeight">,
): number {
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask || bid;
  const totalWeight = strategy.bidWeight + strategy.midWeight + strategy.askWeight;

  if (totalWeight <= 0) {
    return midpoint;
  }

  return (
    bid * strategy.bidWeight +
    midpoint * strategy.midWeight +
    ask * strategy.askWeight
  ) / totalWeight;
}

export function roundOrderPrice(price: number): string {
  return (Math.round(price * 100) / 100).toFixed(2);
}

export function buildClosingOrderPayload(
  snapshot: PositionQuoteSnapshot,
  strategy: ExecutionStrategy,
): OrderPayload | null {
  const quantity = getPositionQuantity(snapshot.position);
  if (quantity <= 0) {
    return null;
  }

  const price = getWeightedOrderPrice(
    snapshot.currentBidPrice,
    snapshot.currentAskPrice,
    strategy,
  );

  if (!(price > 0)) {
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
        symbol: snapshot.position.symbol,
        quantity,
        "instrument-type": normalizeInstrumentType(
          snapshot.position.instrument_type,
        ),
      },
    ],
  };
}

export function getGroupMarketValue(positionSnapshots: PositionQuoteSnapshot[]): number {
  return positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.currentBidPrice * snapshot.quantityWeight,
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