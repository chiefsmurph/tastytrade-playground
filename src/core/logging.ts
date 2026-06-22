import { getBotConfig } from "./bot-config";

const ACCOUNT_NUMBER_PATTERN = /\b\d{6,}\b/g;
const TOKEN_KEY_PATTERN = /(token|secret|authorization|auth|password)/i;

export function redactAccountNumber(value: string): string {
  return value.replace(ACCOUNT_NUMBER_PATTERN, (match) => {
    if (match.length <= 4) {
      return "****";
    }
    return `${"*".repeat(Math.max(4, match.length - 4))}${match.slice(-4)}`;
  });
}

export function redactSensitiveValue(value: unknown): unknown {
  const config = getBotConfig();

  if (!config.logging.redactAccountNumbers) {
    return value;
  }

  if (typeof value === "string") {
    return redactAccountNumber(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (TOKEN_KEY_PATTERN.test(key)) {
        result[key] = "[REDACTED]";
        continue;
      }
      result[key] = redactSensitiveValue(nestedValue);
    }
    return result;
  }

  return value;
}

export function safeJson(value: unknown): string {
  return JSON.stringify(redactSensitiveValue(value), null, 2);
}
