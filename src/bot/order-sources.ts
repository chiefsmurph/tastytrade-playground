export const BOT_ORDER_SOURCE = "tastytrade-playground";
export const SECRET_AUTO_SEED_ORDER_SOURCE = "tastytrade-playground-secret-auto-seed";

export function isSecretAutoSeedOrderSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim() === SECRET_AUTO_SEED_ORDER_SOURCE;
}