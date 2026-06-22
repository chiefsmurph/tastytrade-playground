import { TastytradeAccountBalance } from "./types";

export function getAccountBalanceNumber(
  accountBalance: TastytradeAccountBalance,
  key: keyof TastytradeAccountBalance,
): number {
  const rawAccountBalance = accountBalance as unknown as Record<string, unknown>;
  const keyString = String(key);
  const alternateKey = keyString.includes("-")
    ? keyString
    : keyString
        .replace(/_/g, "-")
        .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const rawValue = rawAccountBalance[keyString] ?? rawAccountBalance[alternateKey];
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getSignedPendingCash(accountBalance: TastytradeAccountBalance): number {
  const pendingCash = getAccountBalanceNumber(accountBalance, "pending-cash");
  const rawAccountBalance = accountBalance as unknown as Record<string, unknown>;
  const effect = String(rawAccountBalance["pending-cash-effect"] ?? "").toLowerCase();

  if (effect === "debit") {
    return -pendingCash;
  }

  return pendingCash;
}

export function getEffectiveTotalCapital(accountBalance: TastytradeAccountBalance): number {
  const derivativeBuyingPower = getAccountBalanceNumber(
    accountBalance,
    "derivative-buying-power",
  );
  const usedDerivativeBuyingPower = getAccountBalanceNumber(
    accountBalance,
    "used-derivative-buying-power",
  );
  const derivativeCapacity = derivativeBuyingPower + usedDerivativeBuyingPower;

  if (derivativeCapacity > 0) {
    return derivativeCapacity;
  }

  if (derivativeBuyingPower > 0) {
    return derivativeBuyingPower;
  }

  const equityBuyingPower = getAccountBalanceNumber(
    accountBalance,
    "equity-buying-power",
  );
  if (equityBuyingPower > 0) {
    return equityBuyingPower;
  }

  const netLiq = getAccountBalanceNumber(accountBalance, "net-liquidating-value");

  if (netLiq > 0) {
    return netLiq;
  }

  return netLiq + getSignedPendingCash(accountBalance);
}