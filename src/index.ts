import { config } from "dotenv";
import axios from "axios";
import tastytradeApi from "./tastytradeClient";
import { AccountBalance, CurrentPosition } from "./types";
import { getBidAskForSymbol } from "./market-data";
import { fetchOptionChains, fetchOptionVolumes, mergeVolumesIntoChain } from "./option-service";

config();

console.log({ pr: process.env.BASE_URL });



(async () => {
  try {
    const accounts = await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
    const extractedAccountNumbers = accounts.map((item: any) => item.account["account-number"]);
    console.log({ accounts, extractedAccountNumbers });

    const currentPositions: CurrentPosition[] = await tastytradeApi.balancesAndPositionsService.getPositionsList(extractedAccountNumbers[0]);
    console.log({ currentPositions });

    // Fetch option chains for RUM
    const optionChains = await fetchOptionChains("RUM");
    console.log("Option chains for RUM:", JSON.stringify(optionChains, null, 2));
    // Also collect a short sample of volumes for option contracts
    const optionVolumes = await fetchOptionVolumes("RUM", 5000);
    const merged = mergeVolumesIntoChain(optionChains, optionVolumes);
    console.log("Merged option chain with volumes:", JSON.stringify(merged, null, 2));

    const quote = await getBidAskForSymbol(".RUM260724C10");
    console.log("Bid/Ask for .RUM260724C10:", quote);
    // sample run completed
  } catch (err: any) {
    console.error("Unhandled error:", err?.message || err);
  }
})();
