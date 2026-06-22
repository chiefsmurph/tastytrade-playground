import TastytradeClient from "@tastytrade/api";
import { config } from "dotenv";
import type { TypedOrderService } from "./tastytrade-order-service";
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

export type TypedTastytradeClient = Omit<
  RawTastytradeClient,
  "accountsAndCustomersService" | "balancesAndPositionsService" | "instrumentsService" | "orderService"
> & {
  accountsAndCustomersService: TypedAccountsAndCustomersService;
  balancesAndPositionsService: TypedBalancesAndPositionsService;
  instrumentsService: TypedInstrumentsService;
  orderService: TypedOrderServiceWithRaw;
};

const tastytradeApi = rawTastytradeApi as unknown as TypedTastytradeClient;

export default tastytradeApi;


