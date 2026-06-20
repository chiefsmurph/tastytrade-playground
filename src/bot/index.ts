import { config } from "dotenv";
import tastytradeApi from "../core/tastytrade-client";
import { CurrentPosition } from "../core/types";
import { getBidAskForSymbol } from "../core/market-data";
import {
  fetchOptionChainsWithVolume,
} from "../core/option-service";

config();

(async () => {
  
})();
