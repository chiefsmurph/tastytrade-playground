import { config as loadDotenv } from "dotenv";
import TastytradeClient, { type ClientConfig } from "./tastytrade-sdk";
import { getBotConfig } from "./bot-config";

loadDotenv();

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getTastytradeClientConfig(): ClientConfig {
  const botConfig = getBotConfig();
  const sdkEnvironmentConfig =
    botConfig.environment === "production"
      ? TastytradeClient.ProdConfig
      : TastytradeClient.SandboxConfig;

  return {
    ...sdkEnvironmentConfig,
    refreshToken: readRequiredEnv("API_REFRESH_TOKEN"),
    clientSecret: readRequiredEnv("API_CLIENT_SECRET"),
    oauthScopes: ["read", "trade"],
  } as ClientConfig;
}

export function validateRuntimeEnvironment(): void {
  getTastytradeClientConfig();
}
