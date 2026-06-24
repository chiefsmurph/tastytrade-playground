import tastytradeApi from "./tastytrade-client";
import type { TastytradeCustomerAccountResource } from "./types";

function normalizeMarginOrCash(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

let customerAccountsPromise: ReturnType<
  typeof tastytradeApi.accountsAndCustomersService.getCustomerAccounts
> | null = null;

async function getCustomerAccounts() {
  customerAccountsPromise ??=
    tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
  return customerAccountsPromise as Promise<TastytradeCustomerAccountResource[]>;
}

export async function getAccountMarginOrCash(
  accountNumber: string,
): Promise<"margin" | "cash" | "unknown"> {
  const normalizedAccountNumber = String(accountNumber).trim();
  if (!normalizedAccountNumber) {
    return "unknown";
  }

  const accounts = await getCustomerAccounts();
  const matchingAccount = accounts.find(
    (item: TastytradeCustomerAccountResource) =>
      item.account?.["account-number"] === normalizedAccountNumber,
  );
  const normalized = normalizeMarginOrCash(
    matchingAccount?.account?.["margin-or-cash"],
  );

  if (normalized === "margin") {
    return "margin";
  }

  if (normalized === "cash") {
    return "cash";
  }

  return "unknown";
}

export async function getDefaultAccountNumber(): Promise<string> {
  const accounts = await getCustomerAccounts();

  const preferredAccount =
    accounts.find(
      (item: TastytradeCustomerAccountResource) =>
        normalizeMarginOrCash(item.account?.["margin-or-cash"]) === "margin" &&
        item.account?.["is-closed"] !== true,
    ) ??
    accounts.find(
      (item: TastytradeCustomerAccountResource) =>
        item.account?.["is-closed"] !== true,
    );

  const accountNumber = preferredAccount?.account?.["account-number"];
  if (!accountNumber) {
    throw new Error("No account number available");
  }

  return accountNumber;
}
