import TastytradeClient from "@tastytrade/api";
import { config } from "dotenv";
import type { TypedOrderService } from "./tastytrade-order-service";
import type { getBidAskForSymbol as GetBidAskForSymbol, getUnderlyingPrice as GetUnderlyingPrice } from "./market-data";
import type { fetchOptionChain as FetchOptionChain, fetchOptionChainWithVolume as FetchOptionChainWithVolume } from "./option-service";
import type { cancelAllLiveOrders as CancelAllLiveOrders } from "~/bot/execute-position-evaluations";
import type {
  AccountBalance,
  CurrentPosition,
  CustomerAccountResource,
  OptionChains,
} from "./types";

config();

const rawTastytradeApi = new TastytradeClient({
  baseUrl: process.env.BASE_URL as string,
  accountStreamerUrl: "wss://streamer.cert.tastyworks.com/streamer",
  refreshToken: process.env.API_REFRESH_TOKEN as string,
  clientSecret: process.env.API_CLIENT_SECRET as string,
  oauthScopes: ["read", "trade"],
});

type RawTastytradeClient = InstanceType<typeof TastytradeClient>;

type TypedAccountsAndCustomersService = {
  getCustomerAccounts(): Promise<CustomerAccountResource[]>;
} & RawTastytradeClient["accountsAndCustomersService"];

type TypedBalancesAndPositionsService = {
  getPositionsList(accountNumber: string): Promise<CurrentPosition[]>;
  getAccountBalanceValues(accountNumber: string): Promise<AccountBalance>;
} & RawTastytradeClient["balancesAndPositionsService"];

type TypedInstrumentsService = {
  getNestedOptionChain(symbol: string): Promise<OptionChains>;
} & RawTastytradeClient["instrumentsService"];

type TypedOrderServiceWithRaw = TypedOrderService & RawTastytradeClient["orderService"];

export interface JohnsService {
  cancelAllLiveOrders: (
    ...args: Parameters<typeof CancelAllLiveOrders>
  ) => ReturnType<typeof CancelAllLiveOrders>;
  fetchOptionChain: (
    ...args: Parameters<typeof FetchOptionChain>
  ) => ReturnType<typeof FetchOptionChain>;
  fetchOptionChainWithVolume: (
    ...args: Parameters<typeof FetchOptionChainWithVolume>
  ) => ReturnType<typeof FetchOptionChainWithVolume>;
  getBidAskForSymbol: (
    ...args: Parameters<typeof GetBidAskForSymbol>
  ) => ReturnType<typeof GetBidAskForSymbol>;
  getUnderlyingPrice: (
    ...args: Parameters<typeof GetUnderlyingPrice>
  ) => ReturnType<typeof GetUnderlyingPrice>;
}

export type TypedTastytradeClient = Omit<
  RawTastytradeClient,
  "accountsAndCustomersService" | "balancesAndPositionsService" | "instrumentsService" | "orderService"
> & {
  accountsAndCustomersService: TypedAccountsAndCustomersService;
  balancesAndPositionsService: TypedBalancesAndPositionsService;
  instrumentsService: TypedInstrumentsService;
  johnsService: JohnsService;
  orderService: TypedOrderServiceWithRaw;
};

const tastytradeApi = rawTastytradeApi as unknown as TypedTastytradeClient;

tastytradeApi.johnsService = {
  async getBidAskForSymbol(...args) {
    const { getBidAskForSymbol } = await import("./market-data");
    return getBidAskForSymbol(...args);
  },
  async getUnderlyingPrice(...args) {
    const { getUnderlyingPrice } = await import("./market-data");
    return getUnderlyingPrice(...args);
  },
  async fetchOptionChain(...args) {
    const { fetchOptionChain } = await import("./option-service");
    return fetchOptionChain(...args);
  },
  async fetchOptionChainWithVolume(...args) {
    const { fetchOptionChainWithVolume } = await import("./option-service");
    return fetchOptionChainWithVolume(...args);
  },
  async cancelAllLiveOrders(...args) {
    const { cancelAllLiveOrders } = await import("~/bot/execute-position-evaluations");
    return cancelAllLiveOrders(...args);
  },
};

export default tastytradeApi;


