export interface SecretSourcePosition {
  ticker?: string;
  buyWeight?: number;
  daytradeScore?: number;
  qualityToBuy?: boolean | string | number;
  returnPerc?: number;
  superRecScore?: number;
  [key: string]: unknown;
}

export interface SecretDataUpdatePayload {
  positions?: {
    [key: string]: SecretSourcePosition[] | unknown;
  };
  [key: string]: unknown;
}
