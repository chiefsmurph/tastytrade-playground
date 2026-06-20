import { config } from "dotenv";
import tastytradeApi from "../core/tastytrade-client";
import { CurrentPosition } from "../core/types";
import { getBidAskForSymbol } from "../core/market-data";
import {
  fetchOptionChainsWithVolume,
} from "../core/option-service";

config();

(async () => {
  try {
    const accounts =
      await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
    const extractedAccountNumbers = accounts.map(
      (item: any) => item.account["account-number"],
    );
    console.log({ accounts, extractedAccountNumbers });

    const currentPositions: CurrentPosition[] =
      await tastytradeApi.balancesAndPositionsService.getPositionsList(
        extractedAccountNumbers[0],
      );
    console.log({ currentPositions });

    const optionChains = await fetchOptionChainsWithVolume("RUM");

    const quote = await getBidAskForSymbol("RUM");
    console.log("Bid/Ask for RUM:", quote);
    // sample run completed
  } catch (err: any) {
    console.error("Unhandled error:", err?.message || err);
  }
})();
