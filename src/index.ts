import { startIpcServer } from "./ipc-server";
import { startMarketOpenScheduler } from "./bot/market-open-scheduler";
import { startSecretSocketConnection } from "./bot/secret";

startSecretSocketConnection();
startIpcServer();

if (process.env.BOT_RUN_ON_SCHEDULE === "true") {
	console.log("Starting market-open scheduler");
	startMarketOpenScheduler();
}
