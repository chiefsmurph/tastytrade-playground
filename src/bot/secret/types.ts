export interface SecretSourcePosition {
  ticker?: string;
  buyWeight?: number;
  daytradeScore?: number;
  qualityToBuy?: boolean | string | number;
  returnPerc?: number;
  superRecScore?: number;
  [key: string]: unknown;
}

export interface SecretTickerRecPick {
  ticker?: string;
  shouldBuy?: boolean | string | number;
  [key: string]: unknown;
}

export interface SecretTickerRecsUpdate {
  picks?: SecretTickerRecPick[] | unknown;
  [key: string]: unknown;
}

export interface SecretDataUpdatePayload {
  positions?: {
    [key: string]: SecretSourcePosition[] | unknown;
  };
  tickerRecs?: SecretTickerRecsUpdate | unknown;
  [key: string]: unknown;
}
