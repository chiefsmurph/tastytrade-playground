let restartScheduled = false;

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isFatalQuoteStreamerMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unhandled dxlink error") ||
    normalized.includes("unauthorized") ||
    normalized.includes("number of user sessions has exceeded the configured limit") ||
    normalized.includes("message: 'bye'") ||
    normalized.includes('message: "bye"') ||
    normalized.includes("dxlink")
  );
}

export function triggerQuoteStreamerRestart(reason: string, details?: unknown): void {
  if (restartScheduled) {
    return;
  }

  restartScheduled = true;
  const extra = details == null ? "" : ` details=${stringifyUnknown(details)}`;
  console.error(
    `[quote-streamer] Fatal condition detected (${reason}). Exiting for PM2 restart.${extra}`,
  );

  setTimeout(() => {
    process.exit(1);
  }, 250);
}

export function restartOnFatalQuoteStreamerError(
  reason: string,
  errorLike: unknown,
): void {
  const message = stringifyUnknown(errorLike);
  if (isFatalQuoteStreamerMessage(message)) {
    triggerQuoteStreamerRestart(reason, errorLike);
  }
}

function joinConsoleArgs(args: unknown[]): string {
  return args.map((value) => stringifyUnknown(value)).join(" ");
}

export function installQuoteStreamerConsoleGuard(): void {
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    const message = joinConsoleArgs(args);
    if (isFatalQuoteStreamerMessage(message)) {
      triggerQuoteStreamerRestart("console.warn dxLink fatal message", message);
    }
    originalWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    const message = joinConsoleArgs(args);
    if (isFatalQuoteStreamerMessage(message)) {
      triggerQuoteStreamerRestart("console.error dxLink fatal message", message);
    }
    originalError(...args);
  };
}
