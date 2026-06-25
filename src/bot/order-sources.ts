export const BOT_ORDER_SOURCE = "tastytrade-playground";
export const CASH_ACCOUNT_SEED_FROM_MARGIN_ORDER_SOURCE =
  "tastytrade-playground-cash-account-seed-from-margin";
export const SECRET_AUTO_SEED_ORDER_SOURCE = "tastytrade-playground-secret-auto-seed";

export function isCashAccountSeedFromMarginOrderSource(
  source: string | null | undefined,
): boolean {
  return String(source ?? "").trim() === CASH_ACCOUNT_SEED_FROM_MARGIN_ORDER_SOURCE;
}

export function isSecretAutoSeedOrderSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim() === SECRET_AUTO_SEED_ORDER_SOURCE;
}