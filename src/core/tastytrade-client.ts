import TastytradeClient from "./tastytrade-sdk";
import { getTastytradeClientConfig } from "./env";

const tastytradeApi = new TastytradeClient(getTastytradeClientConfig());

export default tastytradeApi;
