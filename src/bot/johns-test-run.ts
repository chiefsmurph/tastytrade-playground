import tastytradeApi from "~/core/tastytrade-client";
import { CurrentPosition } from "~/core/types";
import { chooseOptionCandidates } from "./option-contracts";

export default async function johnsTestRun() {
  console.log("Starting John's test run...");
  try {
    const accounts =
      await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
    const extractedAccountNumbers = accounts.map(
      (item) => item.account["account-number"],
    );
    console.log({ accounts, extractedAccountNumbers });

    const currentPositions: CurrentPosition[] =
      await tastytradeApi.balancesAndPositionsService.getPositionsList(
        extractedAccountNumbers[0],
      );
    console.log({ currentPositions });

    const optionChain = await tastytradeApi.johnsService.fetchOptionChain("RUM");
    const underlyingPrice = await tastytradeApi.johnsService.getUnderlyingPrice("RUM");
    const optionCandidates = chooseOptionCandidates(
      optionChain,
      underlyingPrice?.underlyingPrice || 0,
    );
    console.log(JSON.stringify({ optionChain, optionCandidates }, null, 2));

    const quote = await tastytradeApi.johnsService.getBidAskForSymbol("RUM");
    console.log("Bid/Ask for RUM:", quote);
    // sample run completed
  } catch (err: any) {
    console.error("Unhandled error:", err?.message || err);
  }
}
