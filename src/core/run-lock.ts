let activeOperation: string | null = null;

export class LiveTradingLockError extends Error {
  readonly code = "LIVE_TRADING_LOCKED";

  constructor(operation: string, currentOperation: string) {
    super(
      `Cannot start ${operation}; live trading operation ${currentOperation} is already running`,
    );
    this.name = "LiveTradingLockError";
  }
}

export function getLiveTradingLockStatus() {
  return {
    activeOperation,
    locked: activeOperation != null,
  };
}

export async function withLiveTradingLock<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (activeOperation) {
    throw new LiveTradingLockError(operation, activeOperation);
  }

  activeOperation = operation;
  try {
    return await fn();
  } finally {
    activeOperation = null;
  }
}
