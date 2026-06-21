import tastytradeApi from "../core/tastytrade-client";
import { getAccountBalanceNumber } from "../core/account-balance";
import { AccountBalance } from "../core/types";
import executePositionEvaluations from "./execute-position-evaluations";
import { getPositionEvaluations } from "./get-position-evaluations";
import { setLastBotRunState } from "./last-run-state";

export default async function everyFourMinutes() {
  const accounts =
    await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
  const extractedAccountNumbers: string[] = accounts.map(
    (item: any) => item.account["account-number"],
  );
  const accountNumber = extractedAccountNumbers[0];
  console.log({ accounts, extractedAccountNumbers, accountNumber });
  const accountBalances: AccountBalance =
    await tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    );
  console.log(
    "Current account balances:",
    JSON.stringify(accountBalances, null, 2),
  );

  // implement cancel all open orders before getting current buying power to ensure we have the most accurate buying power available for new orders

  const buyingPower = getAccountBalanceNumber(
    accountBalances,
    "derivative_buying_power",
    "derivative-buying-power",
  );
  console.log("Current buying power:", buyingPower);

  const completedEvaluations = await getPositionEvaluations(accountNumber);
  const executionResults = await executePositionEvaluations(
    accountNumber,
    accountBalances,
    completedEvaluations,
  );

  setLastBotRunState(
    accountNumber,
    completedEvaluations,
    executionResults,
  );

  console.log(
    "Grouped position evaluations:",
    JSON.stringify(
      completedEvaluations.map((evaluation) => ({
        underlyingSymbol: evaluation.underlyingSymbol,
        positionSymbols: evaluation.positions.map((position) => position.symbol),
        currentBidPrice: evaluation.metrics.currentBidPrice,
        currentAskPrice: evaluation.metrics.currentAskPrice,
        weightedAverageFill: evaluation.metrics.weightedAverageFill,
        currentReturn: evaluation.currentReturn,
        strategy: evaluation.strategy,
      })),
      null,
      2,
    ),
  );

  console.log(
    "Execution results:",
    JSON.stringify(executionResults, null, 2),
  );

  return executionResults;
}
