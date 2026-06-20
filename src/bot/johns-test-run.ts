import tastytradeApi from "../core/tastytrade-client";
import { getBidAskForSymbol, getUnderlyingPrice } from "../core/market-data";
import { fetchOptionChainsWithVolume } from "../core/option-service";
import { CurrentPosition } from "../core/types";
import { chooseOptionCandidates } from "./option-contracts";

export default async function johnsTestRun() {
  console.log("Starting John's test run...");
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
    const underlyingPrice = await getUnderlyingPrice("RUM");
    const optionCandidates = optionChains.map((chain) =>
      chooseOptionCandidates(chain, underlyingPrice?.underlyingPrice || 0),
    );
    console.log(JSON.stringify({ optionChains, optionCandidates }, null, 2));

    const quote = await getBidAskForSymbol("RUM");
    console.log("Bid/Ask for RUM:", quote);
    // sample run completed
  } catch (err: any) {
    console.error("Unhandled error:", err?.message || err);
  }
}
