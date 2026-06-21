import { AccountBalance } from "./types";

export function getAccountBalanceNumber(
  accountBalance: AccountBalance,
  snakeCaseKey: keyof AccountBalance,
  kebabCaseKey: string,
): number {
  const rawAccountBalance = accountBalance as unknown as Record<string, unknown>;
  const rawValue =
    rawAccountBalance[snakeCaseKey as string] ?? rawAccountBalance[kebabCaseKey];
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getSignedPendingCash(accountBalance: AccountBalance): number {
  const pendingCash = getAccountBalanceNumber(
    accountBalance,
    "pending_cash",
    "pending-cash",
  );
  const rawAccountBalance = accountBalance as unknown as Record<string, unknown>;
  const effect = String(
    rawAccountBalance.pending_cash_effect ??
      rawAccountBalance["pending-cash-effect"] ??
      "",
  ).toLowerCase();

  if (effect === "debit") {
    return -pendingCash;
  }

  return pendingCash;
}

export function getEffectiveTotalCapital(accountBalance: AccountBalance): number {
  return (
    getAccountBalanceNumber(
      accountBalance,
      "net_liquidating_value",
      "net-liquidating-value",
    ) + getSignedPendingCash(accountBalance)
  );
}