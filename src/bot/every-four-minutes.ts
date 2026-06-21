import tastytradeApi from "../core/tastytrade-client";
import { CurrentPosition } from "../core/types";

export default async function everyFourMinutes() {
  const accounts =
    await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
  const extractedAccountNumbers: string[] = accounts.map(
    (item: any) => item.account["account-number"],
  );
  const accountNumber = extractedAccountNumbers[0];
  console.log({ accounts, extractedAccountNumbers, accountNumber });
  const accountBalances =
    await tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    );
  console.log(
    "Current account balances:",
    JSON.stringify(accountBalances, null, 2),
  );

  // implement cancel all open orders before getting current buying power to ensure we have the most accurate buying power available for new orders

  const buyingPower = Number(accountBalances["derivative-buying-power"]);
  console.log("Current buying power:", buyingPower);

  const currentPositions: CurrentPosition[] =
    await tastytradeApi.balancesAndPositionsService.getPositionsList(
      extractedAccountNumbers[0],
    );
}
