export interface SecretSourcePosition {
  ticker?: string;
  buyWeight?: number;
  [key: string]: unknown;
}

export interface SecretDataUpdatePayload {
  positions?: {
    [key: string]: SecretSourcePosition[] | unknown;
  };
  [key: string]: unknown;
}
