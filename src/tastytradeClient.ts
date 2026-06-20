import TastytradeClient from "@tastytrade/api";
import { config } from "dotenv";

config();

const tastytradeApi = new TastytradeClient({
  baseUrl: process.env.BASE_URL as string,
  accountStreamerUrl: "wss://streamer.cert.tastyworks.com/streamer",
  refreshToken: process.env.API_REFRESH_TOKEN as string,
  clientSecret: process.env.API_CLIENT_SECRET as string,
  oauthScopes: ["read", "trade"],
});

export default tastytradeApi;
