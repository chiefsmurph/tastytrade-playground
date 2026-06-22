import {
  getBotConfig,
  getLiveOrderDisabledReason,
  isLiveOrderSubmissionEnabled,
} from "../../core/bot-config";
import tastytradeApi from "../../core/tastytrade-client";
import { OrderPayload } from "./order-utils";

export interface SafeOrderResult {
  dryRunAttempted: boolean;
  dryRunPassed: boolean;
  dryRunResponse?: unknown;
  error?: unknown;
  liveOrdersEnabled: boolean;
  orderResponse?: unknown;
  skippedReason?: string;
  submitted: boolean;
}

function extractBrokerError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const withResponse = error as Error & {
    response?: {
      data?: unknown;
      status?: number;
    };
  };

  return withResponse.response?.data ?? error.message;
}

export function getOrderErrorMessage(error: unknown, fallback: string): string {
  const brokerError = extractBrokerError(error);
  if (typeof brokerError === "string" && brokerError.trim()) {
    return brokerError;
  }

  if (brokerError && typeof brokerError === "object") {
    const maybeMessage = brokerError as {
      error?: { message?: string };
      message?: string;
    };
    return maybeMessage.error?.message ?? maybeMessage.message ?? fallback;
  }

  return fallback;
}

export async function placeOrderSafely(
  accountNumber: string,
  order: OrderPayload,
): Promise<SafeOrderResult> {
  const config = getBotConfig();
  const liveOrdersEnabled = isLiveOrderSubmissionEnabled(config);
  let dryRunResponse: unknown;

  if (config.liveOrders.alwaysDryRunFirst) {
    try {
      dryRunResponse = await tastytradeApi.orderService.postOrderDryRun(
        accountNumber,
        order,
      );
    } catch (error) {
      return {
        dryRunAttempted: true,
        dryRunPassed: false,
        dryRunResponse: extractBrokerError(error),
        error: extractBrokerError(error),
        liveOrdersEnabled,
        submitted: false,
        skippedReason: getOrderErrorMessage(error, "order dry run failed"),
      };
    }
  }

  const disabledReason = getLiveOrderDisabledReason(config);
  if (!liveOrdersEnabled) {
    return {
      dryRunAttempted: config.liveOrders.alwaysDryRunFirst,
      dryRunPassed: config.liveOrders.alwaysDryRunFirst,
      dryRunResponse,
      liveOrdersEnabled,
      submitted: false,
      skippedReason: disabledReason,
    };
  }

  try {
    const orderResponse = await tastytradeApi.orderService.createOrder(
      accountNumber,
      order,
    );
    return {
      dryRunAttempted: config.liveOrders.alwaysDryRunFirst,
      dryRunPassed: true,
      dryRunResponse,
      liveOrdersEnabled,
      orderResponse,
      submitted: true,
    };
  } catch (error) {
    return {
      dryRunAttempted: config.liveOrders.alwaysDryRunFirst,
      dryRunPassed: true,
      dryRunResponse,
      error: extractBrokerError(error),
      liveOrdersEnabled,
      submitted: false,
      skippedReason: getOrderErrorMessage(error, "live order submit failed"),
    };
  }
}
