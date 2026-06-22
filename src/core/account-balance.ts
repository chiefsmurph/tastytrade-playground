import { AccountBalance } from "./types";
import { normalizeAccountBalance, readBrokerField } from "./normalize";

function camelCaseKey(key: string): string {
  return key.replace(/_+([a-zA-Z0-9])/g, (_, part: string) =>
    part.toUpperCase(),
  );
}

export function getAccountBalanceNumber(
  accountBalance: AccountBalance,
  snakeCaseKey: keyof AccountBalance,
  kebabCaseKey: string,
): number {
  const rawValue = readBrokerField(accountBalance, [
    snakeCaseKey as string,
    kebabCaseKey,
    camelCaseKey(snakeCaseKey as string),
  ]);
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getSignedPendingCash(accountBalance: AccountBalance): number {
  const pendingCash = getAccountBalanceNumber(
    accountBalance,
    "pending_cash",
    "pending-cash",
  );
  const effect = String(
    readBrokerField(accountBalance, [
      "pending_cash_effect",
      "pending-cash-effect",
      "pendingCashEffect",
    ]) ?? "",
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

export async function fetchNormalizedAccountBalance(
  accountNumber: string,
): Promise<AccountBalance> {
  const { default: tastytradeApi } = await import("./tastytrade-client");
  return normalizeAccountBalance(
    await tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    ),
  );
}
