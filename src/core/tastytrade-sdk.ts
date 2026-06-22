import { createRequire } from "node:module";
import type TastytradeClientType from "@tastytrade/api";
import type { MarketDataSubscriptionType as MarketDataSubscriptionTypeType } from "@tastytrade/api";

export type ClientConfig = {
  accountStreamerUrl: string;
  baseUrl: string;
  clientSecret: string;
  refreshToken: string;
  oauthScopes: string[];
};

type TastytradeSdk = {
  default: typeof TastytradeClientType;
  MarketDataSubscriptionType: typeof MarketDataSubscriptionTypeType;
};

const require = createRequire(import.meta.url);
const sdk = require("@tastytrade/api") as TastytradeSdk;

export const MarketDataSubscriptionType = sdk.MarketDataSubscriptionType;
export default sdk.default;
